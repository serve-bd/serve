import path from "node:path";
import type Docker from "dockerode";
import type { ServerCtx } from "@/server/servers/context";
import { imageExists, LABEL, pullImage } from "@/server/docker/client";
import { PROXY_IMAGE, PROXY_PROTOCOL_PORTS } from "./templates";
import type { ProxyFile, RunningKind } from "./config";

/*
 * Ports of the machine in custom proxy files (nginx, Caddy or Traefik). Inside the proxy
 * container 127.0.0.1 is the container itself, so `proxy_pass http://127.0.0.1:3000` (or
 * `reverse_proxy 127.0.0.1:3000`, or `url: http://127.0.0.1:3000`) would reach nothing. Serve
 * makes it reach the machine instead, without changing the file:
 *
 *   proxy → its own 127.0.0.1:3000 (a companion container in the proxy's network namespace)
 *         → relay (host network, listens on the Docker bridge address only, lets in only the
 *           proxy) → the machine's 127.0.0.1:3000
 *
 * Both hops pass bytes through: headers, Host, TLS and WebSockets are untouched. Only the files
 * of the proxy kind in use count; another kind's files are kept, inactive, until it is back.
 */

/** First port the relay listens on (one per machine port, in order). */
const RELAY_BASE_PORT = 61_000;
export const MAX_HOST_PORTS = 200;

/** `127.0.0.1:3000` and `localhost:3000` in a file, outside comments. */
const LOOPBACK = /(?<![\w.-])(?:127\.0\.0\.1|localhost):(\d{1,5})(?![\d])/g;
/** Ports a custom nginx file listens on itself (`listen 8443 ssl;`, `listen 127.0.0.1:9000;`). */
const NGINX_LISTEN = /(?:^|[{;\s])listen\s+(?:\[[^\]]*\]:|[\w.-]+:)?(\d{1,5})\b/g;

const lines = (files: ProxyFile[] | undefined) => (files ?? []).flatMap((f) => f.content.split("\n").map((l) => l.replace(/#.*$/, "")));

/** Ports the proxy listens on inside its own container: a machine port with the same number cannot pass through it. */
export function proxyOwnPorts(kind: RunningKind, files: ProxyFile[] | undefined, proxyProtocol: boolean) {
  const own = new Set<number>([80, 443]);
  if (kind === "nginx") {
    if (proxyProtocol) for (const p of [PROXY_PROTOCOL_PORTS.http, PROXY_PROTOCOL_PORTS.https]) own.add(p);
    for (const line of lines(files)) for (const m of line.matchAll(NGINX_LISTEN)) own.add(Number(m[1]));
  }
  // Caddy's admin API and Traefik's API listen on the container's loopback.
  if (kind === "caddy") own.add(2019);
  if (kind === "traefik") own.add(8080);
  return own;
}

/** Machine ports named in these files, sorted. */
export function hostPortsIn(files: ProxyFile[] | undefined): number[] {
  const ports = new Set<number>();
  for (const line of lines(files))
    for (const m of line.matchAll(LOOPBACK)) {
      const port = Number(m[1]);
      if (port >= 1 && port <= 65_535) ports.add(port);
    }
  return [...ports].sort((a, b) => a - b);
}

/**
 * Why these files cannot be saved, or null. A port the proxy uses itself is not relayed: there
 * 127.0.0.1 still reaches the proxy, as it always did (a file may proxy to another of its own).
 */
export function hostPortIssue(kind: RunningKind, files: ProxyFile[] | undefined, proxyProtocol: boolean): string | null {
  const own = proxyOwnPorts(kind, files, proxyProtocol);
  const ports = hostPortsIn(files).filter((p) => !own.has(p));
  if (ports.length > MAX_HOST_PORTS) return `Custom files can reach at most ${MAX_HOST_PORTS} ports of this machine.`;
  return null;
}

export type RelayPlan = { bridge: string; routes: { port: number; relayPort: number }[] };

export function relayPlan(kind: RunningKind, files: ProxyFile[] | undefined, bridge: string, proxyProtocol: boolean): RelayPlan {
  const own = proxyOwnPorts(kind, files, proxyProtocol);
  const ports = hostPortsIn(files)
    .filter((p) => !own.has(p))
    .slice(0, MAX_HOST_PORTS);
  return { bridge, routes: ports.map((port, i) => ({ port, relayPort: RELAY_BASE_PORT + i })) };
}

const streamConfig = (servers: string[]) => `# Managed by Serve. Changes will be overwritten.
worker_processes 1;
worker_rlimit_nofile 65536;
error_log /dev/stderr warn;
pid /tmp/serve-host-ports.pid;

events {
    worker_connections 8192;
}

stream {
${servers.join("\n")}
}
`;

/** The companion in the proxy's network namespace: the proxy's own 127.0.0.1:PORT leads to the relay. */
export function companionConfig(plan: RelayPlan): string {
  return streamConfig(plan.routes.map((r) => `    server {\n        listen 127.0.0.1:${r.port};\n        proxy_pass ${plan.bridge}:${r.relayPort};\n    }`));
}

/** The relay: on the bridge address only, for the proxy's addresses only. */
export function relayConfig(plan: RelayPlan, allowed: string[]): string {
  const allow = allowed.length ? [...allowed.map((ip) => `        allow ${ip};`), "        deny all;"] : ["        deny all;"];
  return streamConfig(
    plan.routes.map((r) => [`    server {`, `        listen ${plan.bridge}:${r.relayPort};`, ...allow, `        proxy_pass 127.0.0.1:${r.port};`, `    }`].join("\n")),
  );
}

export const relayContainer = (ctx: Pick<ServerCtx, "proxyContainer">) => `${ctx.proxyContainer}-host-relay`;
export const companionContainer = (ctx: Pick<ServerCtx, "proxyContainer">) => `${ctx.proxyContainer}-host-ports`;
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

async function remove(ctx: ServerCtx, name: string) {
  await ctx.docker
    .getContainer(name)
    .remove({ force: true })
    .catch(() => {});
}

/** Removed with the proxy, or when no file of the proxy in use names a machine port. One listing when there is none. */
export async function removeHostRelay(ctx: ServerCtx) {
  const names = new Set([companionContainer(ctx), relayContainer(ctx)]);
  const found = await ctx.docker.listContainers({ all: true, filters: { name: [...names] } }).catch(() => null);
  if (found && !found.some((c) => c.Names.some((n) => names.has(n.replace(/^\//, ""))))) return;
  for (const name of names) await remove(ctx, name);
}

/** nginx -s reload in a running stream container: open connections stay, a refused config leaves the old one. */
async function reload(container: Docker.Container, conf: string) {
  const exec = await container.exec({ Cmd: ["nginx", "-c", conf, "-s", "reload"], AttachStdout: true, AttachStderr: true });
  await new Promise<void>((resolve) => {
    exec.start({}, (_err, stream) => {
      if (!stream) return resolve();
      stream.on("end", () => resolve());
      stream.on("error", () => resolve());
      stream.resume();
    });
  });
}

async function startStream(ctx: ServerCtx, name: string, conf: string, networkMode: string, kind: string) {
  // A server running Caddy never pulled the nginx image these use.
  if (!(await imageExists(PROXY_IMAGE, ctx.docker))) await pullImage(PROXY_IMAGE, undefined, null, ctx.docker);
  const container = await ctx.docker.createContainer({
    name,
    Image: PROXY_IMAGE,
    Cmd: ["nginx", "-c", `/etc/serve-relay/${conf}`, "-g", "daemon off;"],
    Labels: { [LABEL.managed]: "true", [LABEL.kind]: kind },
    HostConfig: {
      NetworkMode: networkMode,
      RestartPolicy: { Name: "unless-stopped" },
      // Two descriptors per relayed connection.
      Ulimits: [{ Name: "nofile", Soft: 65_536, Hard: 65_536 }],
      Binds: [`${relayDir(ctx)}:/etc/serve-relay:ro`],
      LogConfig: { Type: "json-file", Config: { "max-size": "5m", "max-file": "2" } },
    },
  });
  await container.start();
}

/**
 * Both stream containers, once the proxy container runs (the relay lets only its addresses in,
 * the companion joins its network namespace). Runs when the proxy is created or restarted and when
 * its files change; also on a timer, since Docker may restart the proxy on its own.
 */
export async function syncHostRelay(ctx: ServerCtx, kind: RunningKind, files: ProxyFile[] | undefined, proxyProtocol: boolean, log?: (line: string) => void) {
  if (!hostPortsIn(files).length) return removeHostRelay(ctx);
  const plan = relayPlan(kind, files, await bridgeAddress(ctx), proxyProtocol);
  if (!plan.routes.length) return removeHostRelay(ctx);
  const proxy = await ctx.docker
    .getContainer(ctx.proxyContainer)
    .inspect()
    .catch(() => null);
  // No proxy to stand in for: nothing would reach the relay either.
  if (!proxy?.State?.Running) return removeHostRelay(ctx);

  const ips = Object.values(proxy.NetworkSettings?.Networks ?? {})
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
  const relayChanged = await ctx.fs.writeIfChanged(path.posix.join(dir, "relay.conf"), relayConfig(plan, allowed));
  const companionChanged = await ctx.fs.writeIfChanged(path.posix.join(dir, "ports.conf"), companionConfig(plan));

  const relay = ctx.docker.getContainer(relayContainer(ctx));
  const relayInfo = await relay.inspect().catch(() => null);
  if (relayInfo?.State?.Running && relayInfo.Config.Cmd?.includes("/etc/serve-relay/relay.conf")) {
    if (relayChanged) await reload(relay, "/etc/serve-relay/relay.conf");
  } else {
    if (relayInfo) await remove(ctx, relayContainer(ctx));
    // The machine's own network: its 127.0.0.1 is the machine's.
    await startStream(ctx, relayContainer(ctx), "relay.conf", "host", "proxy-relay");
    log?.(`Host port relay started (${plan.routes.map((r) => r.port).join(", ")})`);
  }

  // The companion lives in the proxy's network namespace, which a new or restarted proxy replaces.
  const companionInfo = await ctx.docker
    .getContainer(companionContainer(ctx))
    .inspect()
    .catch(() => null);
  const joined = companionInfo?.HostConfig?.NetworkMode === `container:${proxy.Id}`;
  const fresh = !!companionInfo && new Date(companionInfo.State.StartedAt).getTime() >= new Date(proxy.State.StartedAt).getTime();
  if (companionInfo?.State?.Running && joined && fresh) {
    if (companionChanged) await reload(ctx.docker.getContainer(companionContainer(ctx)), "/etc/serve-relay/ports.conf");
    return;
  }
  // Started again, or made anew for another proxy container.
  await remove(ctx, companionContainer(ctx));
  await startStream(ctx, companionContainer(ctx), "ports.conf", `container:${proxy.Id}`, "proxy-host-ports");
}
