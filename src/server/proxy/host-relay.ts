import path from "node:path";
import type { ServerCtx } from "@/server/servers/context";
import { LABEL } from "@/server/docker/client";
import { PROXY_IMAGE, PROXY_PROTOCOL_PORTS } from "./templates";
import type { ProxyFile } from "./config";

/*
 * Ports of the machine in custom nginx files. Inside the proxy container 127.0.0.1 is the
 * container itself, so `proxy_pass http://127.0.0.1:3000` would reach nothing. Serve makes it
 * reach the machine instead, without changing the file:
 *
 *   proxy (its own 127.0.0.1:3000, a stream listener) → relay (host network, listens on the
 *   Docker bridge address only, accepts only the proxy) → the machine's 127.0.0.1:3000
 *
 * Headers, Host and WebSockets are untouched: both hops pass bytes through.
 */

/** First port the relay listens on (one per machine port, in order). */
const RELAY_BASE_PORT = 61_000;
export const MAX_HOST_PORTS = 200;

/** `127.0.0.1:3000` and `localhost:3000` in a file, outside comments. */
const LOOPBACK = /(?<![\w.-])(?:127\.0\.0\.1|localhost):(\d{1,5})(?![\d])/g;

/** Ports the proxy listens on inside its own container: a machine port with the same number cannot pass through it. */
export function proxyOwnPorts(proxyProtocol: boolean) {
  return new Set<number>([80, 443, ...(proxyProtocol ? [PROXY_PROTOCOL_PORTS.http, PROXY_PROTOCOL_PORTS.https] : [])]);
}

/** Machine ports named in these files, sorted. */
export function hostPortsIn(files: ProxyFile[] | undefined): number[] {
  const ports = new Set<number>();
  for (const f of files ?? []) {
    for (const raw of f.content.split("\n")) {
      const line = raw.replace(/#.*$/, "");
      for (const m of line.matchAll(LOOPBACK)) {
        const port = Number(m[1]);
        if (port >= 1 && port <= 65_535) ports.add(port);
      }
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/** Why these files cannot reach the machine as written, or null. */
export function hostPortIssue(files: ProxyFile[] | undefined, proxyProtocol: boolean): string | null {
  const ports = hostPortsIn(files);
  const own = proxyOwnPorts(proxyProtocol);
  const taken = ports.filter((p) => own.has(p));
  if (taken.length)
    return `Port ${taken.join(", ")} of this machine cannot be reached as 127.0.0.1 or localhost: the proxy uses ${taken.length > 1 ? "those ports" : "that port"} itself. Move the app to another port.`;
  if (ports.length > MAX_HOST_PORTS) return `Custom files can reach at most ${MAX_HOST_PORTS} ports of this machine.`;
  return null;
}

export type RelayPlan = { bridge: string; routes: { port: number; relayPort: number }[] };

export function relayPlan(files: ProxyFile[] | undefined, bridge: string, proxyProtocol: boolean): RelayPlan {
  const own = proxyOwnPorts(proxyProtocol);
  const ports = hostPortsIn(files)
    .filter((p) => !own.has(p))
    .slice(0, MAX_HOST_PORTS);
  return { bridge, routes: ports.map((port, i) => ({ port, relayPort: RELAY_BASE_PORT + i })) };
}

/** Stream listeners inside the proxy container: its own 127.0.0.1:PORT leads to the relay. */
export function proxyStreamConfig(plan: RelayPlan): string | null {
  if (!plan.routes.length) return null;
  const servers = plan.routes.map((r) => `server {\n    listen 127.0.0.1:${r.port};\n    proxy_pass ${plan.bridge}:${r.relayPort};\n}`);
  return `# Managed by Serve: ports of this machine named in custom files (127.0.0.1 or localhost).\n${servers.join("\n")}\n`;
}

/** The relay's whole nginx config: on the bridge address only, for the proxy's addresses only. */
export function relayConfig(plan: RelayPlan, allowed: string[]): string {
  const allow = allowed.length ? [...allowed.map((ip) => `        allow ${ip};`), "        deny all;"] : ["        deny all;"];
  const servers = plan.routes.map((r) =>
    [`    server {`, `        listen ${plan.bridge}:${r.relayPort};`, ...allow, `        proxy_pass 127.0.0.1:${r.port};`, `    }`].join("\n"),
  );
  return `# Managed by Serve. Changes will be overwritten.
worker_processes 1;
error_log /dev/stderr warn;
pid /tmp/serve-relay.pid;

events {
    worker_connections 4096;
}

stream {
${servers.join("\n")}
}
`;
}

export const relayContainer = (ctx: Pick<ServerCtx, "proxyContainer">) => `${ctx.proxyContainer}-host-relay`;
export const proxyStreamDir = (ctx: Pick<ServerCtx, "paths">) => path.posix.join(ctx.paths.proxySites, "host-ports");
const relayDir = (ctx: Pick<ServerCtx, "paths">) => path.posix.join(ctx.paths.proxy, "host-relay");

/** The address `host.docker.internal` leads to: the gateway of Docker's default bridge. */
export async function bridgeAddress(ctx: ServerCtx): Promise<string> {
  const info = await ctx.docker
    .getNetwork("bridge")
    .inspect()
    .catch(() => null);
  const gateway = (info?.IPAM?.Config as { Gateway?: string }[] | undefined)?.find((c) => c.Gateway && /^\d+(\.\d+){3}$/.test(c.Gateway))?.Gateway;
  return gateway ?? "172.17.0.1";
}

/** The proxy side: written with the other static files, loaded on the next reload. */
export async function writeProxyStream(ctx: ServerCtx, files: ProxyFile[] | undefined, proxyProtocol: boolean): Promise<boolean> {
  const dir = proxyStreamDir(ctx);
  const file = path.posix.join(dir, "serve.stream");
  const plan = relayPlan(files, hostPortsIn(files).length ? await bridgeAddress(ctx) : "", proxyProtocol);
  const content = proxyStreamConfig(plan);
  if (!content) {
    if (!(await ctx.fs.exists(file))) return false;
    await ctx.fs.rm(file);
    return true;
  }
  await ctx.fs.mkdir(dir);
  return ctx.fs.writeIfChanged(file, content);
}

async function removeRelay(ctx: ServerCtx) {
  await ctx.docker
    .getContainer(relayContainer(ctx))
    .remove({ force: true })
    .catch(() => {});
}

/**
 * The relay side, once the proxy container exists (the relay lets only its addresses in). Runs
 * when the proxy is created or its files change; removed when no file names a machine port.
 */
export async function syncHostRelay(ctx: ServerCtx, files: ProxyFile[] | undefined, proxyProtocol: boolean, log?: (line: string) => void) {
  const ports = hostPortsIn(files);
  if (!ports.length) return removeRelay(ctx);
  const plan = relayPlan(files, await bridgeAddress(ctx), proxyProtocol);
  if (!plan.routes.length) return removeRelay(ctx);
  const proxy = await ctx.docker
    .getContainer(ctx.proxyContainer)
    .inspect()
    .catch(() => null);
  const ips = Object.values(proxy?.NetworkSettings?.Networks ?? {})
    .map((n) => n?.IPAddress)
    .filter((ip): ip is string => !!ip && /^\d+(\.\d+){3}$/.test(ip));
  // Serve's own network too: only Serve's containers join it (stacks cannot), and the proxy keeps
  // reaching the relay when Docker gives it another address on that network (after a reboot).
  const own = await ctx.docker
    .getNetwork(ctx.network)
    .inspect()
    .catch(() => null);
  const subnet = (own?.IPAM?.Config as { Subnet?: string }[] | undefined)?.find((c) => c.Subnet && /^\d+(\.\d+){3}\/\d+$/.test(c.Subnet))?.Subnet;
  const allowed = [...new Set([...ips, ...(subnet ? [subnet] : [])])].sort();
  const dir = relayDir(ctx);
  await ctx.fs.mkdir(dir);
  const changed = await ctx.fs.writeIfChanged(path.posix.join(dir, "nginx.conf"), relayConfig(plan, allowed));
  const relay = ctx.docker.getContainer(relayContainer(ctx));
  const info = await relay.inspect().catch(() => null);
  if (info?.State?.Running) {
    if (!changed) return;
    // A reload keeps the open connections; a config it refuses leaves the old one running.
    const exec = await relay.exec({ Cmd: ["nginx", "-c", "/etc/serve-relay/nginx.conf", "-s", "reload"], AttachStdout: true, AttachStderr: true });
    await new Promise<void>((resolve) => {
      exec.start({}, (_err, stream) => {
        if (!stream) return resolve();
        stream.on("end", () => resolve());
        stream.on("error", () => resolve());
        stream.resume();
      });
    });
    return;
  }
  if (info) await removeRelay(ctx);
  const container = await ctx.docker.createContainer({
    name: relayContainer(ctx),
    Image: PROXY_IMAGE,
    Cmd: ["nginx", "-c", "/etc/serve-relay/nginx.conf", "-g", "daemon off;"],
    Labels: { [LABEL.managed]: "true", [LABEL.kind]: "proxy-relay" },
    HostConfig: {
      // The machine's own network: its 127.0.0.1 is the machine's.
      NetworkMode: "host",
      RestartPolicy: { Name: "unless-stopped" },
      // Two descriptors per relayed connection.
      Ulimits: [{ Name: "nofile", Soft: 65_536, Hard: 65_536 }],
      Binds: [`${dir}:/etc/serve-relay:ro`],
      LogConfig: { Type: "json-file", Config: { "max-size": "5m", "max-file": "2" } },
    },
  });
  await container.start();
  log?.(`Host port relay started (${plan.routes.map((r) => r.port).join(", ")})`);
}

/** Removed with the proxy. */
export const removeHostRelay = removeRelay;
