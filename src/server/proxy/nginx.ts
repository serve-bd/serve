import path from "node:path";
import { maintenanceHtml, maintenanceOf, maintenancePageName } from "@/server/services/maintenance";
import { and, eq, inArray, or } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LOCAL_SERVER_ID } from "@/server/db/schema";
import { decrypt } from "@/server/crypto";
import { demuxDockerBuffer, ensureNetwork, execInContainer, imageExists, LABEL, pullImage } from "@/server/docker/client";
import { env } from "@/server/env";
import { proxyPaths } from "@/server/paths";
import { getSettings } from "@/server/settings";
import { getServer, listServers, type ServerCtx } from "@/server/servers/context";
import {
  mainConfig,
  maintenanceGeo,
  maintenanceVar,
  errorPages,
  pagesServerConfig,
  PROXY_IMAGE,
  proxyParams,
  proxyParamsPlain,
  realIpConfig,
  serverBlocks,
  tunnelRealIp,
  upstreamBlock,
  type SiteOptions,
  type SiteServer,
  type SiteUpstream,
} from "./templates";
import { certificateCovers } from "@/server/ssl/match";
import { composeAlias, tunnelNetworkName, upstreamName } from "./names";
import { connectProxy, connectProxyToAll, envNetworkName } from "@/server/docker/networks";
import crypto from "node:crypto";
import { customFilePattern, DEFAULT_MAX_BODY_SIZE, defaultsOf, proxyImages, type ProxyFile, type ProxyKind, type RunningKind, type ServerProxyConfig } from "./config";
import { appTargets, certificateStamp, dashboardModel, serviceModel, type SiteModel } from "./model";
import { forgetDashboardTrusted, visitorIpOf } from "./trusted-proxies";
import { allTrusted, type TrustedProxies } from "@/lib/trusted-proxies";
import { runServerIds } from "@/server/deploy/distribution";
import { runsAsExtraOn } from "@/server/services/distribution-query";
import { caddyMainConfig, renderCaddySite } from "./caddy";
import { renderTraefikSite, TRAEFIK_API, traefikBaseDynamic, traefikRouters, traefikStaticArgs, type ExpectedRouter } from "./traefik";

/**
 * Reverse proxies, one per server: nginx, Caddy or Traefik. Every server has
 * its own `serve-proxy` container with config files in its data directory;
 * all reads and writes go through the server's ServerCtx, so local and remote
 * proxies share this code. The file keeps its historical name; it is the
 * facade for every proxy kind.
 */

type Log = (line: string) => void;

/** Serialize config changes per server so concurrent deploys never race each other. */
const chains = new Map<string, Promise<unknown>>();
function serialized<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(serverId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(
    serverId,
    next.catch(() => {}),
  );
  return next;
}

const local = () => getServer(LOCAL_SERVER_ID);
const KIND_LABEL = "serve.proxy-kind";
const EXT: Record<RunningKind, string> = { nginx: ".conf", caddy: ".caddy", traefik: ".yml" };
const SPEC_LABEL = "serve.proxy-spec";
/** Custom files an admin added are written with this prefix. */
const USER_PREFIX = "user-";
/** Traefik files Serve writes next to the sites that are not sites themselves. */
const TRAEFIK_BASE = "_serve.yml";
const TRAEFIK_CUSTOM = "_custom.yml";

/** The proxy kind and settings of a server, read fresh (the server context is cached). */
export async function proxyStateOf(serverId: string): Promise<{ kind: ProxyKind; config: ServerProxyConfig; stopped: boolean }> {
  const [row] = await db
    .select({ kind: schema.server.proxyKind, config: schema.server.proxyConfig, stopped: schema.server.proxyStopped })
    .from(schema.server)
    .where(eq(schema.server.id, serverId));
  return { kind: (row?.kind as ProxyKind) ?? "nginx", config: row?.config ?? {}, stopped: row?.stopped ?? false };
}

/** Servers whose proxies Serve keeps in sync: the local one and every remote server set up successfully. */
export async function activeServers(): Promise<ServerCtx[]> {
  const rows = await listServers();
  const out: ServerCtx[] = [];
  for (const row of rows) {
    if (!row.isLocal && row.status !== "ready") continue;
    try {
      out.push(await getServer(row.id));
    } catch {
      // key missing or similar: the server page shows the problem
    }
  }
  return out;
}

const customFile = (ctx: ServerCtx) => path.posix.join(ctx.paths.proxyCustom, "custom.conf");
const serverRawFile = (ctx: ServerCtx) => path.posix.join(ctx.paths.proxyCustom, "server.conf");
const realIpFile = (ctx: ServerCtx) => path.posix.join(ctx.paths.proxyCustom, "00-real-ip.conf");
const caddyExtraFile = (ctx: ServerCtx) => path.posix.join(ctx.paths.proxyCustom, "extra.caddy");
const plainParamsFile = (ctx: ServerCtx) => path.posix.join(ctx.paths.proxySites, "params", "plain.conf");
/** htpasswd of a service with basic auth, on the server and as nginx sees it. */
const authFile = (ctx: ServerCtx, serviceId: string) => path.posix.join(ctx.paths.proxySites, "auth", `${serviceId}.htpasswd`);
const authFileInProxy = (serviceId: string) => `${proxyPaths.sites}/auth/${serviceId}.htpasswd`;
const pagesContainer = (ctx: ServerCtx) => `${ctx.proxyContainer}-pages`;

function customContent(config: string | null, heading = "custom directives from Server → Proxy") {
  return config?.trim() ? `# Managed by Serve — ${heading}.\n${config.trim()}\n` : null;
}

async function writeOrRemove(ctx: ServerCtx, file: string, content: string | null) {
  if (content) return ctx.fs.writeIfChanged(file, content);
  if (!(await ctx.fs.exists(file))) return false;
  await ctx.fs.rm(file);
  return true;
}

/** Write (or remove) the custom http-level config file. Returns true when it changed. */
async function writeCustomConfig(ctx: ServerCtx, config: string | null) {
  return writeOrRemove(ctx, customFile(ctx), customContent(config));
}

async function writePages(ctx: ServerCtx) {
  let changed = false;
  const { productName } = await import("@/server/branding");
  for (const [name, html] of Object.entries(errorPages(await productName().catch(() => "Serve")))) {
    changed = (await ctx.fs.writeIfChanged(path.posix.join(ctx.paths.proxy, "pages", name), html)) || changed;
  }
  return changed;
}

/** Servers whose running nginx still sees the previous nginx.conf (see writeStaticFiles). */
const staleMounts = new Set<string>();
const MAIN_TEST = ".serve-nginx-main.test";

/** Write the admin's custom files for a kind and remove ones that were deleted. */
async function writeUserFiles(ctx: ServerCtx, dir: string, files: ProxyFile[] | undefined, pattern: RegExp) {
  let changed = false;
  const wanted = new Map((files ?? []).filter((f) => pattern.test(f.name)).map((f) => [`${USER_PREFIX}${f.name}`, f.content.endsWith("\n") ? f.content : `${f.content}\n`]));
  for (const existing of await ctx.fs.readdir(dir)) {
    if (existing.startsWith(USER_PREFIX) && pattern.test(existing.slice(USER_PREFIX.length)) && !wanted.has(existing)) {
      await ctx.fs.rm(path.posix.join(dir, existing));
      changed = true;
    }
  }
  for (const [name, content] of wanted) changed = (await ctx.fs.writeIfChanged(path.posix.join(dir, name), content)) || changed;
  return changed;
}

/** Static files of the server's proxy kind. Returns true when anything changed. */
async function writeStaticFiles(ctx: ServerCtx, kind: ProxyKind, config: ServerProxyConfig) {
  if (kind === "none") return false;
  const settings = await getSettings();
  const p = ctx.paths;
  let changed = false;
  for (const dir of [p.proxySites, p.proxyCustom, p.proxyLogs, p.acme, p.letsencrypt, p.certs]) await ctx.fs.mkdir(dir);
  changed = (await writePages(ctx)) || changed;
  const visitor = await visitorIpOf(ctx);

  if (kind === "nginx") {
    // If the proxy container started before these files existed (fresh data directory),
    // Docker created directories in their place. Replace them with the real files.
    for (const file of ["nginx.conf", "proxy_params.conf"]) {
      const target = path.posix.join(p.proxy, file);
      if ((await ctx.fs.stat(target))?.isDirectory) {
        await ctx.fs.rm(target);
        changed = true;
      }
    }
    const n = config.nginx ?? {};
    const { catchAll, unknownRedirect } = defaultsOf(n.defaults);
    const main = mainConfig({ ...n, maxBodySize: n.maxBodySize || DEFAULT_MAX_BODY_SIZE, catchAll, unknownRedirect });
    const mainChanged = await ctx.fs.writeIfChanged(path.posix.join(p.proxy, "nginx.conf"), main);
    const paramsChanged = await ctx.fs.writeIfChanged(path.posix.join(p.proxy, "proxy_params.conf"), proxyParams);
    if (mainChanged || paramsChanged) {
      // Both are single-file mounts: an atomic write replaces the file, and a running container keeps
      // the old one until it restarts. A copy in the (directory-mounted) sites folder lets nginx test it first.
      await ctx.fs.writeFile(path.posix.join(p.proxySites, MAIN_TEST), main);
      staleMounts.add(ctx.id);
      changed = true;
    }
    // Lives in the mounted sites dir (not globbed as a site), so existing proxies see it without a new mount.
    changed = (await ctx.fs.writeIfChanged(plainParamsFile(ctx), proxyParamsPlain)) || changed;
    // Instance-wide directives are Root's: an organization's own server does not get them.
    changed = (await writeCustomConfig(ctx, ctx.row.ownerOrganizationId ? null : settings.proxyCustomConfig)) || changed;
    changed = (await writeOrRemove(ctx, serverRawFile(ctx), null)) || changed;
    changed = (await writeOrRemove(ctx, realIpFile(ctx), realIpConfig(visitor))) || changed;
    changed = (await writeUserFiles(ctx, p.proxyCustom, n.files, customFilePattern.nginx)) || changed;
  } else if (kind === "caddy") {
    const c = config.caddy ?? {};
    await ctx.fs.mkdir(path.posix.join(p.proxy, "caddy-data"));
    await ctx.fs.mkdir(path.posix.join(p.proxy, "caddy-config"));
    changed =
      (await ctx.fs.writeIfChanged(
        path.posix.join(p.proxy, "caddy", "Caddyfile"),
        caddyMainConfig(c, { email: settings.acmeEmail, staging: settings.acmeStaging, visitor, defaults: defaultsOf(c.defaults) }),
      )) || changed;
    changed = (await writeOrRemove(ctx, caddyExtraFile(ctx), null)) || changed;
    changed = (await writeUserFiles(ctx, p.proxyCustom, c.files, customFilePattern.caddy)) || changed;
  } else {
    const t = config.traefik ?? {};
    await ctx.fs.mkdir(path.posix.join(p.proxy, "traefik-data"));
    changed =
      (await ctx.fs.writeIfChanged(
        path.posix.join(p.proxySites, TRAEFIK_BASE),
        traefikBaseDynamic({ pagesUrl: `http://${pagesContainer(ctx)}:80`, resolver: !!settings.acmeEmail, dashboard: t.dashboard ?? null, defaults: defaultsOf(t.defaults) }),
      )) || changed;
    changed = (await writeOrRemove(ctx, path.posix.join(p.proxySites, TRAEFIK_CUSTOM), null)) || changed;
    if (await ctx.fs.writeIfChanged(path.posix.join(p.proxy, "pages-server", "default.conf"), pagesServerConfig)) {
      changed = true;
      // The pages server reads its config at start: reload a running one.
      await ctx.docker
        .getContainer(pagesContainer(ctx))
        .exec({ Cmd: ["nginx", "-s", "reload"] })
        .then((e) => e.start({}))
        .catch(() => {});
    }
    changed = (await writeUserFiles(ctx, p.proxySites, t.files, customFilePattern.traefik)) || changed;
  }
  return changed;
}

export async function getProxyContainer(ctx?: ServerCtx) {
  const c = ctx ?? (await local());
  try {
    return await c.docker.getContainer(c.proxyContainer).inspect();
  } catch {
    return null;
  }
}

async function removeContainer(ctx: ServerCtx, name: string) {
  await ctx.docker
    .getContainer(name)
    .remove({ force: true })
    .catch(() => {});
}

/** The Cloudflare token Traefik needs for DNS challenges, when configured. */
/** The Cloudflare token for DNS challenges; only an account of the server's owner (Root for instance servers). */
async function traefikDnsToken(serverId: string, config: ServerProxyConfig) {
  const id = config.traefik?.acmeChallenge === "dns-cloudflare" ? config.traefik.cloudflareAccountId : null;
  if (!id) return null;
  const [row] = await db.select({ owner: schema.server.ownerOrganizationId }).from(schema.server).where(eq(schema.server.id, serverId));
  const owner = row?.owner ?? (await getSettings()).rootOrganizationId;
  if (!owner) return null;
  const [account] = await db
    .select({ token: schema.cloudflareAccount.apiToken })
    .from(schema.cloudflareAccount)
    .where(and(eq(schema.cloudflareAccount.id, id), eq(schema.cloudflareAccount.organizationId, owner)));
  return account ? decrypt(account.token) : null;
}

/** Container definition for a proxy kind (image, command, mounts, ports). */
async function containerSpec(ctx: ServerCtx, kind: RunningKind, config: ServerProxyConfig) {
  const base = await baseContainerSpec(ctx, kind, config);
  const o = config[kind]?.container;
  if (!o) return base;
  const ports = { ...base.ports };
  for (const p of o.ports ?? []) {
    const m = /^(?:(\d{1,3}(?:\.\d{1,3}){3}):)?(\d{1,5}):(\d{1,5})(?:\/(tcp|udp))?$/.exec(p);
    if (!m) continue;
    const key = `${m[3]}/${m[4] ?? "tcp"}`;
    ports[key] = [...(ports[key] ?? []), { HostPort: m[2], ...(m[1] ? { HostIp: m[1] } : {}) } as { HostPort: string }];
  }
  const defaultCmd: Record<RunningKind, string[]> = { nginx: ["nginx", "-g", "daemon off;"], caddy: base.Cmd ?? [], traefik: base.Cmd ?? [] };
  return {
    Image: o.image || base.Image,
    Cmd: o.args?.length ? [...(base.Cmd ?? defaultCmd[kind]), ...o.args] : base.Cmd,
    Env: [...base.Env, ...(o.env ?? []).map((e) => `${e.name}=${decrypt(e.value)}`)],
    ports,
    Binds: [...base.Binds, ...(o.volumes ?? [])],
  };
}

async function baseContainerSpec(ctx: ServerCtx, kind: RunningKind, config: ServerProxyConfig) {
  const p = ctx.paths;
  const settings = await getSettings();
  const ports: Record<string, { HostPort: string }[]> = {
    "80/tcp": [{ HostPort: String(ctx.proxyHttpPort) }],
    "443/tcp": [{ HostPort: String(ctx.proxyHttpsPort) }],
  };
  const shared = [
    `${path.posix.join(p.proxy, "pages")}:${proxyPaths.pages}:ro`,
    `${p.proxySites}:${proxyPaths.sites}:ro`,
    `${p.letsencrypt}:${proxyPaths.letsencrypt}:ro`,
    `${p.certs}:${proxyPaths.certs}:ro`,
    `${p.proxyLogs}:${proxyPaths.logs}`,
  ];
  if (kind === "nginx") {
    return {
      Image: PROXY_IMAGE,
      Cmd: undefined as string[] | undefined,
      Env: [] as string[],
      ports,
      Binds: [
        `${path.posix.join(p.proxy, "nginx.conf")}:/etc/nginx/nginx.conf:ro`,
        `${path.posix.join(p.proxy, "proxy_params.conf")}:/etc/nginx/serve/proxy_params.conf:ro`,
        ...shared.slice(0, 2),
        `${p.acme}:${proxyPaths.acme}:ro`,
        ...shared.slice(2),
      ],
    };
  }
  if (kind === "caddy") {
    if (config.caddy?.http3) ports["443/udp"] = [{ HostPort: String(ctx.proxyHttpsPort) }];
    return {
      Image: proxyImages.caddy,
      Cmd: ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
      Env: [] as string[],
      ports,
      Binds: [
        `${path.posix.join(p.proxy, "caddy")}:/etc/caddy:ro`,
        ...shared,
        `${path.posix.join(p.proxy, "caddy-data")}:/data`,
        `${path.posix.join(p.proxy, "caddy-config")}:/config`,
      ],
    };
  }
  const token = await traefikDnsToken(ctx.id, config);
  return {
    Image: proxyImages.traefik,
    Cmd: traefikStaticArgs(config.traefik ?? {}, { email: settings.acmeEmail, staging: settings.acmeStaging, trusted: allTrusted(await visitorIpOf(ctx)), hasDnsToken: !!token }),
    Env: token ? [`CF_DNS_API_TOKEN=${token}`] : [],
    ports,
    Binds: [...shared, `${path.posix.join(p.proxy, "traefik-data")}:/data`],
  };
}

/** The proxy container as a compose-like snippet (secret values masked), for the Proxy page. */
export async function proxyDefinition(ctx: ServerCtx) {
  const { kind, config } = await proxyStateOf(ctx.id);
  if (kind === "none") return null;
  const spec = await containerSpec(ctx, kind, config);
  const q = (v: string) => (/^[\w./:@=-]+$/.test(v) ? v : JSON.stringify(v));
  const lines = ["services:", "  proxy:", `    container_name: ${ctx.proxyContainer}`, `    image: ${spec.Image}`];
  if (spec.Cmd?.length) lines.push("    command:", ...spec.Cmd.map((c) => `      - ${q(c)}`));
  if (spec.Env.length) lines.push("    environment:", ...spec.Env.map((e) => `      - ${e.slice(0, e.indexOf("="))}=********`));
  lines.push("    ports:");
  for (const [key, bindings] of Object.entries(spec.ports)) {
    const [port, proto] = key.split("/");
    for (const b of bindings)
      lines.push(`      - ${q(`${(b as { HostIp?: string }).HostIp ? `${(b as { HostIp?: string }).HostIp}:` : ""}${b.HostPort}:${port}${proto === "udp" ? "/udp" : ""}`)}`);
  }
  lines.push("    volumes:", ...spec.Binds.map((b) => `      - ${q(b)}`), "    networks:", `      - ${ctx.network}`, "    restart: unless-stopped");
  return lines.join("\n");
}

async function ensureImage(ctx: ServerCtx, image: string, log?: Log) {
  if (await imageExists(image, ctx.docker)) return;
  log?.(`Pulling ${image}`);
  await pullImage(image, log, null, ctx.docker);
}

/** Traefik cannot serve files: a tiny nginx serves Serve's 404 and 503 pages for it. */
async function ensurePagesServer(ctx: ServerCtx, log?: Log) {
  const name = pagesContainer(ctx);
  const info = await ctx.docker
    .getContainer(name)
    .inspect()
    .catch(() => null);
  // A release that moves the pinned image replaces it (pull first, so the pages stay up meanwhile).
  if (info && info.Config.Image !== PROXY_IMAGE) {
    await ensureImage(ctx, PROXY_IMAGE, log);
    await removeContainer(ctx, name);
    return ensurePagesServer(ctx, log);
  }
  if (info?.State.Running) return;
  if (info) {
    await ctx.docker
      .getContainer(name)
      .start()
      .catch(() => removeContainer(ctx, name));
    if (
      (
        await ctx.docker
          .getContainer(name)
          .inspect()
          .catch(() => null)
      )?.State.Running
    )
      return;
  }
  await ensureImage(ctx, PROXY_IMAGE, log);
  const c = await ctx.docker.createContainer({
    name,
    Image: PROXY_IMAGE,
    Labels: { [LABEL.managed]: "true", [LABEL.kind]: "proxy-pages" },
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      NetworkMode: ctx.network,
      Binds: [`${path.posix.join(ctx.paths.proxy, "pages-server")}:/etc/nginx/conf.d:ro`, `${path.posix.join(ctx.paths.proxy, "pages")}:/usr/share/serve-pages:ro`],
      LogConfig: { Type: "json-file", Config: { "max-size": "5m", "max-file": "2" } },
    },
  });
  await c.start();
}

/** Host ports another container or program already listens on, among `ports`. Our own proxy is ignored. */
export async function busyProxyPorts(ctx: ServerCtx, ports: number[]) {
  const busy = new Map<number, string>();
  const ours = new Set([ctx.proxyContainer, pagesContainer(ctx)].map((n) => `/${n}`));
  const containers = await ctx.docker.listContainers().catch(() => []);
  const ownPorts = new Set<number>();
  for (const c of containers) {
    const mine = c.Names.some((n) => ours.has(n) || n.startsWith(`/${ctx.proxyContainer}-previous`));
    for (const p of c.Ports) {
      if (!p.PublicPort || !ports.includes(p.PublicPort)) continue;
      if (mine) ownPorts.add(p.PublicPort);
      else busy.set(p.PublicPort, `the container ${c.Names[0]?.replace(/^\//, "")}`);
    }
  }
  // Programs on the host itself (a system nginx on :80, for example). Inside a container this only sees its own namespace.
  const res = await ctx.exec("ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null", { timeoutMs: 5000 }).catch(() => null);
  if (res?.code === 0) {
    for (const line of res.stdout.split("\n")) {
      // ss: "LISTEN 0 4096 0.0.0.0:80 0.0.0.0:*"; netstat: "tcp 0 0 0.0.0.0:80 0.0.0.0:* LISTEN". Local address is the 4th column.
      const local = line.trim().split(/\s+/)[3] ?? "";
      const port = Number(local.slice(local.lastIndexOf(":") + 1));
      if (ports.includes(port) && !ownPorts.has(port) && !busy.has(port)) busy.set(port, "another program");
    }
  }
  return busy;
}

function portError(ctx: ServerCtx, busy: Map<number, string>) {
  const [[port, who]] = [...busy];
  return new ProxyConfigError(`Port ${port} is already used on ${ctx.name} (by ${who}). Choose another port.`);
}

/**
 * Replace the running proxy container without ever leaving the server without
 * one: the old container is renamed and stopped, the new one started, and on
 * any failure the old one comes back.
 */
async function replaceProxy(ctx: ServerCtx, create: () => Promise<void>, log?: Log) {
  const old = await getProxyContainer(ctx);
  const parked = `${ctx.proxyContainer}-previous-${Date.now()}`;
  if (old) {
    await ctx.docker.getContainer(ctx.proxyContainer).rename({ name: parked });
    await ctx.docker
      .getContainer(parked)
      .stop({ t: 5 })
      .catch(() => {});
  }
  try {
    await create();
  } catch (error) {
    await removeContainer(ctx, ctx.proxyContainer);
    if (old) {
      await ctx.docker
        .getContainer(parked)
        .rename({ name: ctx.proxyContainer })
        .catch(() => {});
      if (old.State.Running)
        await ctx.docker
          .getContainer(ctx.proxyContainer)
          .start()
          .catch(() => {});
      log?.("Kept the previous proxy");
    }
    const message = (error as Error).message;
    if (/port is already allocated|address already in use/i.test(message)) {
      const port = /:(\d+)/.exec(message.split("Bind for")[1] ?? message)?.[1] ?? "";
      throw new ProxyConfigError(`Port ${port || "80/443"} is already used on ${ctx.name} (by another program). Choose another port.`);
    }
    throw error;
  }
  if (old) await removeContainer(ctx, parked);
}

/** Create (or repair) the proxy container on a server, for the server's proxy kind. A stopped proxy stays stopped. */
export async function ensureServerProxy(ctx: ServerCtx, log?: Log): Promise<Awaited<ReturnType<typeof getProxyContainer>>> {
  const { kind, config, stopped } = await proxyStateOf(ctx.id);
  if (kind === "none") {
    // No Serve proxy on this server: make sure none is left running.
    await removeProxyContainers(ctx);
    return null;
  }
  await ensureNetwork(ctx.docker, ctx.network);
  // Before the static files: the visitor-IP config trusts this network's subnet.
  await ensureNetwork(ctx.docker, tunnelNetworkName(ctx.network));
  const changed = await writeStaticFiles(ctx, kind, config);
  const info = await getProxyContainer(ctx);
  // A proxy from before the tunnel network joins it (cloudflared reaches the proxy there).
  if (info) await connectProxy(tunnelNetworkName(ctx.network), ctx).catch(() => {});
  const spec = await containerSpec(ctx, kind, config);
  const specHash = crypto.createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 16);
  const mismatch = !!info && (info.Config.Labels?.[KIND_LABEL] ?? "nginx") !== kind;

  if (stopped) {
    // Stopped by an admin: keep it that way (and drop a proxy of the wrong kind).
    if (mismatch) await removeProxyContainers(ctx);
    else {
      if (info?.State.Running)
        await ctx.docker
          .getContainer(ctx.proxyContainer)
          .stop({ t: 5 })
          .catch(() => {});
      await ctx.docker
        .getContainer(pagesContainer(ctx))
        .stop({ t: 2 })
        .catch(() => {});
    }
    return getProxyContainer(ctx);
  }

  if (kind === "traefik") await ensurePagesServer(ctx, log);
  else await removeContainer(ctx, pagesContainer(ctx));

  const create = async () => {
    await ensureImage(ctx, spec.Image, log);
    const container = await ctx.docker.createContainer({
      name: ctx.proxyContainer,
      Image: spec.Image,
      Cmd: spec.Cmd,
      Env: spec.Env,
      Labels: { [LABEL.managed]: "true", [LABEL.kind]: "proxy", [KIND_LABEL]: kind, [SPEC_LABEL]: specHash },
      ExposedPorts: Object.fromEntries(Object.keys(spec.ports).map((k) => [k, {}])),
      HostConfig: {
        RestartPolicy: { Name: "unless-stopped" },
        NetworkMode: ctx.network,
        PortBindings: spec.ports,
        ExtraHosts: ["host.docker.internal:host-gateway"],
        Binds: spec.Binds,
        LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
      },
    });
    staleMounts.delete(ctx.id);
    // Join the environment networks before starting, so upstream names resolve on the first start.
    await connectProxyToAll(ctx);
    await connectProxy(tunnelNetworkName(ctx.network), ctx);
    await container.start();
    log?.(`Proxy container started (${kind})`);
  };

  const hostPorts = [
    ...new Set(
      Object.entries(spec.ports)
        .filter(([k]) => k.endsWith("/tcp"))
        .flatMap(([, v]) => v.map((b) => Number(b.HostPort))),
    ),
  ];
  if (!info) {
    const busy = await busyProxyPorts(ctx, hostPorts);
    if (busy.size) throw portError(ctx, busy);
    await create();
    return getProxyContainer(ctx);
  }

  const bound = info.HostConfig.PortBindings as Record<string, { HostPort?: string }[] | undefined> | undefined;
  const portsDiffer =
    Object.keys(spec.ports).length !== Object.keys(bound ?? {}).length || Object.entries(spec.ports).some(([k, v]) => bound?.[k]?.[0]?.HostPort !== v[0].HostPort);
  // Containers created since the spec label exists are compared as a whole (image, command, environment, mounts, ports).
  const knownHash = info.Config.Labels?.[SPEC_LABEL];
  const staticDiffers = knownHash ? knownHash !== specHash : kind === "traefik" || !!config[kind]?.container;
  if (mismatch || portsDiffer || staticDiffers) {
    log?.(
      mismatch
        ? `Replacing the ${info.Config.Labels?.[KIND_LABEL] ?? "nginx"} proxy with ${kind}`
        : portsDiffer
          ? `Proxy ports changed to ${ctx.proxyHttpPort}/${ctx.proxyHttpsPort}; recreating the proxy`
          : "The proxy container definition changed; recreating the proxy",
    );
    const busy = await busyProxyPorts(ctx, hostPorts);
    if (busy.size) throw portError(ctx, busy);
    // Pull before the old proxy stops, so sites are down only for the swap.
    await ensureImage(ctx, spec.Image, log);
    await replaceProxy(ctx, create, log);
    return getProxyContainer(ctx);
  }
  if (!info.State.Running) {
    try {
      await ctx.docker.getContainer(ctx.proxyContainer).start();
      log?.("Proxy container restarted");
    } catch (error) {
      // Broken mounts (for example after the data directory was wiped): start over.
      log?.(`Proxy did not start (${(error as Error).message.split(":")[0]}); recreating it`);
      await removeContainer(ctx, ctx.proxyContainer);
      return ensureServerProxy(ctx, log);
    }
  } else if (changed) {
    await reloadProxy(ctx);
  }
  return info;
}

/** Create (or repair) the proxy of the machine Serve runs on. */
export async function ensureProxy(log?: Log) {
  return ensureServerProxy(await local(), log);
}

export class ProxyConfigError extends Error {}

async function exec(ctx: ServerCtx, cmd: string[]) {
  return execInContainer(ctx.proxyContainer, cmd, {}, ctx.docker);
}

/** Wait until Traefik reports every expected router as loaded, enabled and matching its file. */
async function traefikCheckRouters(ctx: ServerCtx, expected: ExpectedRouter[], timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  const strip = (v: string) => v.replace(/@file$/, "");
  let problems: string[] = [];
  let broken = false;
  do {
    const res = await exec(ctx, ["wget", "-q", "-O-", `${TRAEFIK_API}/api/http/routers?per_page=10000`]).catch(() => null);
    if (res?.exitCode === 0) {
      let routers: { name: string; status: string; error?: string[]; service?: string; middlewares?: string[] }[] = [];
      try {
        routers = JSON.parse(res.output);
      } catch {
        routers = [];
      }
      const byName = new Map(routers.map((r) => [strip(r.name), r]));
      problems = [];
      broken = false;
      for (const e of expected) {
        const r = byName.get(e.name);
        if (!r) problems.push(`${e.name}: not loaded`);
        else if (strip(r.service ?? "") !== strip(e.service) || JSON.stringify((r.middlewares ?? []).map(strip)) !== JSON.stringify(e.middlewares.map(strip))) {
          problems.push(`${e.name}: previous version still active`);
        } else if (r.status !== "enabled") {
          problems.push(`${e.name}: ${(r.error ?? [r.status]).join("; ")}`);
          broken = true;
        }
      }
      if (!problems.length) return;
      // Loaded but broken: no point in waiting longer.
      if (broken) break;
    }
    await new Promise((r) => setTimeout(r, 400));
  } while (Date.now() < deadline);
  const logs = (await proxyLogs(ctx, 40).catch(() => []))
    .map((l) => l.text.replace(ANSI, ""))
    .filter((t) => /error|cannot|invalid/i.test(t))
    .slice(-3)
    .map((t) => t.replace(/^.*?(ERR|error)\s*/, ""));
  throw new ProxyConfigError(["Traefik did not accept the configuration.", ...problems.slice(0, 5), ...logs].join("\n"));
}

/** Validate config and apply it without dropping connections. `changedFiles` helps Traefik verify what it loaded. */
export async function reloadProxy(ctx?: ServerCtx, changedFiles: string[] = [], since?: LogMark) {
  const c = ctx ?? (await local());
  const { kind } = await proxyStateOf(c.id);
  if (kind === "none") return;
  if (kind === "nginx" && staleMounts.has(c.id)) {
    const test = await exec(c, ["nginx", "-t", "-c", `${proxyPaths.sites}/${MAIN_TEST}`]);
    if (test.exitCode !== 0) throw new ProxyConfigError(test.output.trim().replaceAll(`${proxyPaths.sites}/${MAIN_TEST}`, "/etc/nginx/nginx.conf"));
    // The new main file only reaches the container on a restart (a second or two without traffic).
    await c.docker.getContainer(c.proxyContainer).restart({ t: 5 });
    staleMounts.delete(c.id);
    for (let i = 0; i < 40 && !(await proxyHealthy(c)); i++) await new Promise((r) => setTimeout(r, 250));
  } else if (kind === "nginx") {
    const test = await exec(c, ["nginx", "-t"]);
    if (test.exitCode !== 0) throw new ProxyConfigError(test.output.trim());
    const reload = await exec(c, ["nginx", "-s", "reload"]);
    if (reload.exitCode !== 0) throw new ProxyConfigError(reload.output.trim());
  } else if (kind === "caddy") {
    // Caddy validates and swaps the whole configuration atomically; on error the old one keeps running.
    const res = await exec(c, ["caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile", "--force"]);
    if (res.exitCode !== 0) throw new ProxyConfigError(res.output.trim());
  } else {
    // Traefik watches the files itself; confirm it loaded the routers they define, as written.
    const expected: ExpectedRouter[] = [];
    for (const file of changedFiles) {
      if (!/\.ya?ml$/.test(file)) continue;
      const content = await c.fs.readFile(file).catch(() => null);
      if (content) expected.push(...traefikRouters(content));
    }
    await traefikCheckRouters(c, expected);
    if (since !== undefined) await traefikFileErrors(c, since);
  }
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** Timestamp (the Docker host's clock) of the proxy's last log line, or null before any output. */
type LogMark = string | null;

async function logText(ctx: ServerCtx, opts: { tail?: number; since?: string }) {
  const buffer = (await ctx.docker
    .getContainer(ctx.proxyContainer)
    .logs({ stdout: true, stderr: true, timestamps: true, ...opts })
    .catch(() => Buffer.from(""))) as unknown as Buffer;
  return demuxDockerBuffer(Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer))).replace(ANSI, "");
}

export async function proxyLogMark(ctx: ServerCtx): Promise<LogMark> {
  const lines = (await logText(ctx, { tail: 1 })).trim().split("\n");
  return /^(\d{4}-\d\d-\d\dT\S+)/.exec(lines.at(-1) ?? "")?.[1] ?? null;
}

/** Errors Traefik's file provider logged after a mark (a broken file keeps the previous configuration). */
async function traefikFileErrors(ctx: ServerCtx, mark: LogMark) {
  await new Promise((r) => setTimeout(r, 600));
  const since = mark ? String(new Date(mark).getTime() / 1000) : "0";
  const errors = (await logText(ctx, { since }))
    .split("\n")
    // Docker's `since` has second precision on some engines: drop lines at or before the mark.
    .filter((l) => !mark || (/^(\S+)/.exec(l)?.[1] ?? "") > mark)
    .map((l) => l.replace(/^\S+\s/, ""))
    .filter((l) => /\bERR\b|level=error/.test(l) && /providerName=file|file provider|configuration|unmarshal|yaml/i.test(l));
  if (errors.length) throw new ProxyConfigError(["Traefik could not load the configuration files.", ...errors.slice(-3).map((l) => l.replace(/^\S+\s+ERR\s*/, ""))].join("\n"));
}

type CertRow = typeof schema.certificate.$inferSelect;

function tlsFor(hostname: string, explicitId: string | null, certs: CertRow[]): SiteServer["tls"] {
  const usable = certs.filter((c) => c.status === "active" && c.certPath && c.keyPath);
  const cert = (explicitId && usable.find((c) => c.id === explicitId)) || usable.find((c) => certificateCovers(c.domains, hostname));
  return cert ? { cert: cert.certPath!, key: cert.keyPath! } : null;
}

/** Certificates a site on a server may use: same organization, stored on that server. */
function usableCertificates(organizationId: string, serverId: string) {
  return db
    .select()
    .from(schema.certificate)
    .where(and(eq(schema.certificate.organizationId, organizationId), eq(schema.certificate.serverId, serverId)));
}

/** nginx site of a service (the original renderer, kept byte-for-byte). */
export async function renderServiceSite(serviceId: string, ctx?: ServerCtx): Promise<string | null> {
  const service = await db.query.service.findFirst({
    where: eq(schema.service.id, serviceId),
    with: { domains: true, project: { columns: { organizationId: true } } },
  });
  if (!service || service.type === "database" || service.domains.length === 0) return null;
  const server = ctx ?? (await getServer(service.serverId));

  // Certificates stored on the server this site is written to (extra servers have their own).
  const certs = await usableCertificates(service.project.organizationId, server.id);
  const upstreams = new Map<string, SiteUpstream>();
  const servers: SiteServer[] = [];
  const stopped = service.status === "stopped";

  const containers = service.type === "app" && !stopped ? await appTargets(server, service) : [];
  const errorPages = defaultsOf((await proxyStateOf(server.id)).config.nginx?.defaults).unavailablePage;
  const maintenance = maintenanceOf(service.id, service.maintenance);
  const tunnelIp = service.domains.some((d) => d.tunnelId) ? tunnelRealIp(await visitorIpOf(server)) : null;
  const cfg = service.proxy;
  const options: SiteOptions | null = cfg ? ({ ...cfg, basicAuth: undefined, authFile: cfg.basicAuth ? authFileInProxy(service.id) : null } as SiteOptions) : null;
  // www ↔ apex redirect, only between hostnames that are both on this service.
  const hostnames = new Set(service.domains.map((d) => d.hostname));
  const wwwTarget = (hostname: string) => {
    if (!cfg?.wwwRedirect || cfg.wwwRedirect === "none") return null;
    const other = cfg.wwwRedirect === "to-apex" ? (hostname.startsWith("www.") ? hostname.slice(4) : null) : hostname.startsWith("www.") ? null : `www.${hostname}`;
    if (!other || !hostnames.has(other)) return null;
    const target = service.domains.find((d) => d.hostname === other)!;
    return `${target.https || target.tunnelId ? "https" : "http"}://${other}`;
  };

  for (const d of service.domains) {
    let upstream: string | null = null;
    if (!d.redirectTo && !stopped) {
      const port = d.port ?? service.runtime.port ?? 80;
      if (service.type === "app") {
        const name = upstreamName(service.slug, String(port));
        if (!upstreams.has(name)) {
          upstreams.set(name, { name, servers: containers.map((c) => `${c}:${port}`), sticky: !!cfg?.sticky });
        }
        upstream = name;
      } else if (service.type === "compose" && d.composeService) {
        const name = upstreamName(service.slug, `${d.composeService}_${port}`);
        if (!upstreams.has(name)) {
          upstreams.set(name, {
            name,
            servers: [`${composeAlias(service.slug, d.composeService)}:${port}`],
          });
        }
        upstream = name;
      }
    }
    servers.push({
      hostname: d.hostname,
      upstream,
      redirectTo: d.redirectTo ?? wwwTarget(d.hostname),
      forceHttps: d.forceHttps,
      tls: d.https ? tlsFor(d.hostname, d.certificateId, certs) : null,
      options,
      ...(errorPages ? {} : { errorPages: false }),
      ...(maintenance ? { maintenance: { ...maintenance, geoVar: maintenance.allow.length ? maintenanceVar(service.id) : null } } : {}),
      ...(d.tunnelId && tunnelIp ? { realIp: tunnelIp } : {}),
    });
  }

  const geo = maintenance?.allow.length ? [maintenanceGeo(maintenanceVar(service.id), maintenance.allow)] : [];
  const stamp = certificateStamp(
    certs,
    servers.map((s) => s.tls),
  );
  return [`# Managed by Serve — service "${service.name}" (${service.id}).`, ...stamp, ...geo, ...[...upstreams.values()].map(upstreamBlock), ...servers.map(serverBlocks)].join(
    "\n",
  );
}

export { composeAlias };

/** The dashboard is only served by the proxy of the machine Serve runs on. */
async function renderNginxDashboard(): Promise<string | null> {
  const settings = await getSettings();
  if (!settings.dashboardDomain) return null;
  const certs = settings.rootOrganizationId ? await usableCertificates(settings.rootOrganizationId, LOCAL_SERVER_ID) : [];
  const upstream: SiteUpstream = { name: "serve_dashboard", servers: [env.dashboardUpstream] };
  const tls = settings.dashboardHttps ? tlsFor(settings.dashboardDomain, null, certs) : null;
  const tunnelIp = settings.dashboardTunnelId ? tunnelRealIp(await visitorIpOf(await local())) : null;
  return [
    "# Managed by Serve — dashboard.",
    ...certificateStamp(certs, [tls]),
    upstreamBlock(upstream),
    serverBlocks({
      hostname: settings.dashboardDomain,
      upstream: upstream.name,
      forceHttps: true,
      tls,
      allow: settings.dashboardAllowlist,
      ...(tunnelIp ? { realIp: tunnelIp } : {}),
    }),
  ].join("\n");
}

async function renderModel(kind: RunningKind, ctx: ServerCtx, model: SiteModel | null) {
  if (!model) return null;
  const { config } = await proxyStateOf(ctx.id);
  const stamp = (model.certificates ?? []).map((l) => `${l}\n`).join("");
  const visitor = await visitorIpOf(ctx);
  if (kind === "caddy") return stamp + renderCaddySite(model, defaultsOf(config.caddy?.defaults), !!visitor.header);
  const settings = await getSettings();
  return stamp + renderTraefikSite(model, { resolver: !!settings.acmeEmail, trusted: allTrusted(visitor), defaults: defaultsOf(config.traefik?.defaults) });
}

/** The site Serve generates for a service (ignoring a custom override). */
export async function generatedSite(kind: RunningKind, serviceId: string, ctx: ServerCtx) {
  if (kind === "nginx") return renderServiceSite(serviceId, ctx);
  return renderModel(kind, ctx, await serviceModel(serviceId, ctx));
}

async function renderSite(kind: RunningKind, serviceId: string, ctx: ServerCtx) {
  const [row] = await db.select({ custom: schema.service.proxyCustom }).from(schema.service).where(eq(schema.service.id, serviceId));
  const custom = row?.custom?.[kind];
  if (custom?.trim()) return custom.endsWith("\n") ? custom : `${custom}\n`;
  return generatedSite(kind, serviceId, ctx);
}

async function renderDashboard(kind: RunningKind, ctx: ServerCtx) {
  if (kind === "nginx") return renderNginxDashboard();
  return renderModel(kind, ctx, await dashboardModel());
}

const siteFile = (ctx: ServerCtx, name: string, kind: RunningKind = "nginx") => path.posix.join(ctx.paths.proxySites, `${name}${EXT[kind]}`);

/**
 * Apply a set of file changes atomically: write, test, reload, and roll back
 * every file if the proxy rejects the new configuration.
 */
async function applySites(ctx: ServerCtx, changes: Map<string, string | null>) {
  const since = (await proxyStateOf(ctx.id)).kind === "traefik" ? await proxyLogMark(ctx) : undefined;
  const previous = new Map<string, string | null>();
  for (const [file, content] of changes) {
    const old = await ctx.fs.readFile(file).catch(() => null);
    if (old === content) continue;
    previous.set(file, old);
    if (content === null) await ctx.fs.rm(file);
    else await ctx.fs.writeFile(file, content);
  }
  if (!previous.size) return false;
  if (!(await getProxyContainer(ctx))?.State.Running) return true;
  try {
    await reloadProxy(ctx, [...previous.keys()], since);
  } catch (error) {
    for (const [file, old] of previous) {
      if (old === null) await ctx.fs.rm(file);
      else await ctx.fs.writeFile(file, old);
    }
    const { kind } = await proxyStateOf(ctx.id);
    if (kind === "caddy") await reloadProxy(ctx).catch(() => {});
    throw error;
  }
  return true;
}

const maintenanceFile = (ctx: ServerCtx, serviceId: string) => path.posix.join(ctx.paths.proxy, "pages", maintenancePageName(serviceId));

/** HTML of a service's maintenance page, or null when maintenance is off. */
async function maintenancePageContent(serviceId: string) {
  const [row] = await db.select({ maintenance: schema.service.maintenance }).from(schema.service).where(eq(schema.service.id, serviceId));
  return row?.maintenance?.enabled ? maintenanceHtml(row.maintenance) : null;
}

/**
 * Render the site of one service on the servers it runs on: its own server and
 * any extra servers. Pass `serverId` to update only that one.
 */
export async function syncServiceProxy(serviceId: string, serverId?: string) {
  const [svc] = await db
    .select({ environmentId: schema.service.environmentId, serverId: schema.service.serverId, distribution: schema.service.distribution })
    .from(schema.service)
    .where(eq(schema.service.id, serviceId));
  const ids = serverId ? [serverId] : svc ? runServerIds(svc.serverId, svc.distribution) : [LOCAL_SERVER_ID];
  let firstError: unknown = null;
  for (const [i, id] of ids.entries()) {
    try {
      await syncServiceProxyOn(serviceId, svc, await getServer(id));
    } catch (error) {
      // The service's own server decides; an extra server that fails is reported by its deploys.
      if (i === 0) firstError = error;
    }
  }
  if (firstError) throw firstError;
}

function syncServiceProxyOn(serviceId: string, svc: { environmentId: string } | undefined, ctx: ServerCtx) {
  return serialized(ctx.id, async () => {
    const { kind } = await proxyStateOf(ctx.id);
    if (kind === "none") return;
    await ctx.fs.mkdir(ctx.paths.proxySites);
    if (svc) await connectProxy(envNetworkName(svc.environmentId), ctx).catch(() => {});
    const content = await renderSite(kind, serviceId, ctx);
    const changes = new Map<string, string | null>([[siteFile(ctx, `svc-${serviceId}`, kind), content]]);
    // The page goes in the same change set, so it exists before the proxy points at it.
    changes.set(maintenanceFile(ctx, serviceId), content ? await maintenancePageContent(serviceId) : null);
    if (kind === "nginx") {
      const [row] = await db.select({ proxy: schema.service.proxy }).from(schema.service).where(eq(schema.service.id, serviceId));
      const auth = content && row?.proxy?.basicAuth ? `${row.proxy.basicAuth.username}:${row.proxy.basicAuth.passwordHash}\n` : null;
      if (row?.proxy?.websockets === false) await ctx.fs.writeIfChanged(plainParamsFile(ctx), proxyParamsPlain);
      // The htpasswd file goes in the same change set, so a failed nginx test rolls both back.
      changes.set(authFile(ctx, serviceId), auth);
    }
    await applySites(ctx, changes);
  });
}

/**
 * Remove a service's site. Pass the server it ran on when the service row is
 * already gone (or moved); without it the service's current server is used,
 * and every active server when the service no longer exists.
 */
export async function removeServiceProxy(serviceId: string, serverId?: string) {
  let targets: ServerCtx[];
  if (serverId) targets = [await getServer(serverId)];
  else {
    const [svc] = await db.select({ serverId: schema.service.serverId, distribution: schema.service.distribution }).from(schema.service).where(eq(schema.service.id, serviceId));
    targets = svc ? await Promise.all(runServerIds(svc.serverId, svc.distribution).map((id) => getServer(id))) : await activeServers();
  }
  for (const ctx of targets) {
    await serialized(ctx.id, () =>
      applySites(
        ctx,
        new Map([
          [siteFile(ctx, `svc-${serviceId}`, "nginx"), null],
          [siteFile(ctx, `svc-${serviceId}`, "caddy"), null],
          [siteFile(ctx, `svc-${serviceId}`, "traefik"), null],
          [authFile(ctx, serviceId), null],
          [maintenanceFile(ctx, serviceId), null],
        ]),
      ),
    ).catch((error) => {
      if (serverId || targets.length === 1) throw error;
    });
  }
}

/** Every site file for a kind, keyed by path (stale site files of every kind removed). */
async function siteChanges(ctx: ServerCtx, kind: RunningKind) {
  const changes = new Map<string, string | null>();
  const keep = new Set([TRAEFIK_BASE, TRAEFIK_CUSTOM]);
  for (const f of await ctx.fs.readdir(ctx.paths.proxySites)) {
    if (keep.has(f) || f.startsWith(USER_PREFIX)) continue;
    if (Object.values(EXT).some((e) => f.endsWith(e))) changes.set(path.posix.join(ctx.paths.proxySites, f), null);
  }
  const services = await db
    .select({ id: schema.service.id })
    .from(schema.service)
    .where(and(inArray(schema.service.type, ["app", "compose"]), or(eq(schema.service.serverId, ctx.id), runsAsExtraOn(ctx.id))));
  for (const s of services) {
    changes.set(siteFile(ctx, `svc-${s.id}`, kind), await renderSite(kind, s.id, ctx));
    const page = await maintenancePageContent(s.id);
    if (page) changes.set(maintenanceFile(ctx, s.id), page);
  }
  if (ctx.local) changes.set(siteFile(ctx, "_dashboard", kind), await renderDashboard(kind, ctx));
  if (kind === "nginx") {
    for (const s of services) {
      const [row] = await db.select({ proxy: schema.service.proxy }).from(schema.service).where(eq(schema.service.id, s.id));
      if (row?.proxy?.basicAuth) changes.set(authFile(ctx, s.id), `${row.proxy.basicAuth.username}:${row.proxy.basicAuth.passwordHash}\n`);
    }
  }
  return changes;
}

/** Regenerate every site file on one server, removing stale ones. */
function syncServer(ctx: ServerCtx) {
  return serialized(ctx.id, async () => {
    const { kind, config } = await proxyStateOf(ctx.id);
    if (kind === "none") return;
    const staticChanged = await writeStaticFiles(ctx, kind, config);
    const reloaded = await applySites(ctx, await siteChanges(ctx, kind));
    if (staticChanged && !reloaded && (await getProxyContainer(ctx))?.State.Running) {
      await reloadProxy(ctx, kind === "traefik" ? [path.posix.join(ctx.paths.proxySites, TRAEFIK_BASE)] : []);
    }
  });
}

/** Write every file for a kind without touching the running proxy (used while switching). */
export async function writeAllFiles(ctx: ServerCtx, kind: ProxyKind, config: ServerProxyConfig) {
  if (kind === "none") return;
  return serialized(ctx.id, async () => {
    await writeStaticFiles(ctx, kind, config);
    for (const [file, content] of await siteChanges(ctx, kind)) {
      if (content === null) await ctx.fs.rm(file);
      else await ctx.fs.writeFile(file, content);
    }
  });
}

/**
 * Regenerate every site on every active server. Remote proxies are created or
 * repaired first. A failing remote server does not stop the others; the local
 * server's error is rethrown.
 */
export async function syncAllProxy(log?: Log) {
  const servers = await activeServers();
  let localError: unknown = null;
  for (const ctx of servers) {
    try {
      if (!ctx.local) await ensureServerProxy(ctx, log);
      await syncServer(ctx);
    } catch (error) {
      if (ctx.local) localError = error;
      else log?.(`Proxy sync failed on ${ctx.name}: ${(error as Error).message}`);
    }
  }
  if (localError) throw localError;
}

/** Regenerate every site on one server (after setup or a ports change). */
export async function syncServerProxy(ctx: ServerCtx, log?: Log) {
  await ensureServerProxy(ctx, log);
  await syncServer(ctx);
}

export async function syncDashboardProxy() {
  const ctx = await local();
  return serialized(ctx.id, async () => {
    const { kind } = await proxyStateOf(ctx.id);
    if (kind === "none") return;
    await applySites(ctx, new Map([[siteFile(ctx, "_dashboard", kind), await renderDashboard(kind, ctx)]]));
  });
}

/** Services whose domains use a given certificate (explicitly or by hostname), on the certificate's server. */
export async function servicesUsingCertificate(cert: CertRow): Promise<string[]> {
  const domains = (
    await db
      .select({ domain: schema.domain })
      .from(schema.domain)
      .innerJoin(schema.service, eq(schema.domain.serviceId, schema.service.id))
      .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
      .where(and(eq(schema.project.organizationId, cert.organizationId), eq(schema.service.serverId, cert.serverId)))
  ).map((r) => r.domain);
  return [...new Set(domains.filter((d) => d.certificateId === cert.id || certificateCovers(cert.domains, d.hostname)).map((d) => d.serviceId))];
}

export async function proxyStatus(ctx?: ServerCtx) {
  const info = await getProxyContainer(ctx).catch(() => null);
  return {
    exists: !!info,
    running: !!info?.State.Running,
    image: info?.Config.Image ?? null,
    startedAt: info?.State.StartedAt ?? null,
    kind: ((info?.Config.Labels?.[KIND_LABEL] as ProxyKind | undefined) ?? (info ? "nginx" : null)) as ProxyKind | null,
  };
}

/** Whether the proxy answers its health check (used after switching). */
export async function proxyHealthy(ctx: ServerCtx) {
  const { kind } = await proxyStateOf(ctx.id);
  if (kind === "none") return true;
  const url = kind === "traefik" ? `${TRAEFIK_API}/ping` : "http://127.0.0.1/__serve/health";
  const res = await exec(ctx, ["wget", "-q", "-O-", url]).catch(() => null);
  return res?.exitCode === 0;
}

/* -------------------------------------------------------------------------- */
/*                              Admin inspection                              */
/* -------------------------------------------------------------------------- */

export type ProxyTest = { ok: boolean; output: string; state: "ok" | "failed" | "unavailable" };

/** Docker/runc noise while a container is being replaced: not a configuration error. */
const transient = /No such container|is not running|OCI runtime exec failed|is restarting|removal of container|409|conflict/i;

/** Check the running configuration with the proxy's own tool. */
export async function testProxyConfig(ctx?: ServerCtx): Promise<ProxyTest> {
  const c = ctx ?? (await local());
  const { kind, stopped } = await proxyStateOf(c.id);
  if (kind === "none") return { ok: true, output: "This server runs no Serve proxy.", state: "unavailable" };
  const info = await getProxyContainer(c);
  if (!info?.State.Running)
    return { ok: false, output: stopped ? "The proxy is stopped." : info?.State.Restarting ? "The proxy is restarting." : "The proxy is not running.", state: "unavailable" };
  if ((info.Config.Labels?.[KIND_LABEL] ?? "nginx") !== kind) return { ok: false, output: "The proxy is being replaced.", state: "unavailable" };
  if (kind === "traefik") {
    try {
      const expected: ExpectedRouter[] = [];
      for (const f of await c.fs.readdir(c.paths.proxySites)) {
        if (!/\.ya?ml$/.test(f)) continue;
        expected.push(...traefikRouters((await c.fs.readFile(path.posix.join(c.paths.proxySites, f)).catch(() => "")) ?? ""));
      }
      await traefikCheckRouters(c, expected, 3000);
      return { ok: true, output: `${expected.length} routers loaded`, state: "ok" };
    } catch (error) {
      const message = (error as Error).message;
      return transient.test(message) ? { ok: false, output: "The proxy is restarting.", state: "unavailable" } : { ok: false, output: message, state: "failed" };
    }
  }
  const cmd = kind === "nginx" ? ["nginx", "-t"] : ["caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"];
  try {
    const res = await exec(c, cmd);
    if (res.exitCode !== 0 && transient.test(res.output)) return { ok: false, output: "The proxy is restarting.", state: "unavailable" };
    return { ok: res.exitCode === 0, output: res.output.trim(), state: res.exitCode === 0 ? "ok" : "failed" };
  } catch (error) {
    return transient.test((error as Error).message)
      ? { ok: false, output: "The proxy is restarting.", state: "unavailable" }
      : { ok: false, output: (error as Error).message, state: "failed" };
  }
}

/**
 * Validate and apply custom http-level directives on every active nginx
 * server. If any proxy rejects them, every server gets its previous file back
 * and the nginx error is thrown, so nothing changes.
 */
export async function applyCustomConfig(config: string | null) {
  const servers: ServerCtx[] = [];
  for (const ctx of await activeServers()) if (!ctx.row.ownerOrganizationId && (await proxyStateOf(ctx.id)).kind === "nginx") servers.push(ctx);
  const content = customContent(config);
  const applied: { ctx: ServerCtx; previous: string | null }[] = [];
  try {
    for (const ctx of servers) {
      await serialized(ctx.id, async () => {
        const previous = await ctx.fs.readFile(customFile(ctx)).catch(() => null);
        if (content === previous) return;
        applied.push({ ctx, previous });
        if (content) await ctx.fs.writeFile(customFile(ctx), content);
        else await ctx.fs.rm(customFile(ctx));
        if ((await getProxyContainer(ctx))?.State.Running) {
          try {
            await reloadProxy(ctx);
          } catch (error) {
            if (error instanceof ProxyConfigError && servers.length > 1) error.message = `${ctx.name}: ${error.message}`;
            throw error;
          }
        }
      });
    }
  } catch (error) {
    for (const { ctx, previous } of applied.reverse()) {
      await serialized(ctx.id, async () => {
        if (previous === null) await ctx.fs.rm(customFile(ctx));
        else await ctx.fs.writeFile(customFile(ctx), previous);
        if ((await getProxyContainer(ctx))?.State.Running) await reloadProxy(ctx).catch(() => {});
      }).catch(() => {});
    }
    throw error;
  }
}

/**
 * Save a server's proxy settings for one kind and apply them when that kind is
 * running: rewrite static files, validate with the proxy's own checker, and
 * restore the previous settings (and files) when it rejects them.
 */
export async function applyServerProxyConfig(ctx: ServerCtx, next: ServerProxyConfig, log?: Log) {
  const { kind, config: previous } = await proxyStateOf(ctx.id);
  const since = kind === "traefik" ? await proxyLogMark(ctx) : undefined;
  await db.update(schema.server).set({ proxyConfig: next }).where(eq(schema.server.id, ctx.id));
  try {
    await serialized(ctx.id, async () => {
      const running = (await getProxyContainer(ctx))?.State.Running;
      const changed = await writeStaticFiles(ctx, kind, next);
      if (!running || !changed) return;
      const files =
        kind === "traefik"
          ? [TRAEFIK_BASE, ...(await ctx.fs.readdir(ctx.paths.proxySites)).filter((f) => f.startsWith(USER_PREFIX) && /\.ya?ml$/.test(f))].map((f) =>
              path.posix.join(ctx.paths.proxySites, f),
            )
          : [];
      await reloadProxy(ctx, files, since);
    });
    // Built-in defaults change what every site file contains.
    if (kind !== "none" && JSON.stringify(defaultsOf(previous[kind]?.defaults)) !== JSON.stringify(defaultsOf(next[kind]?.defaults))) await syncServer(ctx);
    // Traefik's static options and Caddy's HTTP/3 port live on the container itself.
    await ensureServerProxy(ctx, log);
    if (!(await proxyStateOf(ctx.id)).stopped && !(await waitHealthy(ctx))) throw new ProxyConfigError("The proxy did not come back healthy with these settings.");
  } catch (error) {
    await db.update(schema.server).set({ proxyConfig: previous }).where(eq(schema.server.id, ctx.id));
    await serialized(ctx.id, () => writeStaticFiles(ctx, kind, previous)).catch(() => {});
    await ensureServerProxy(ctx, log).catch(() => {});
    if ((await getProxyContainer(ctx))?.State.Running) await reloadProxy(ctx).catch(() => {});
    if (kind !== "none") await syncServer(ctx).catch(() => {});
    throw error;
  }
}

/**
 * Save a server's trusted proxies and apply them: the static files (nginx visitor IP file,
 * Caddyfile), every site (tunnel hosts, Traefik allow lists) and Traefik's container command.
 * The previous setting comes back when the proxy rejects the result.
 */
export async function applyTrustedProxies(ctx: ServerCtx, next: TrustedProxies | null, log?: Log) {
  const [row] = await db.select({ previous: schema.server.trustedProxies }).from(schema.server).where(eq(schema.server.id, ctx.id));
  const previous = row?.previous ?? null;
  const store = async (value: TrustedProxies | null) => {
    await db.update(schema.server).set({ trustedProxies: value }).where(eq(schema.server.id, ctx.id));
    if (ctx.local) forgetDashboardTrusted();
  };
  await store(next);
  try {
    await syncServerProxy(ctx, log);
    if (!(await proxyStateOf(ctx.id)).stopped && !(await waitHealthy(ctx))) throw new ProxyConfigError("The proxy did not come back healthy with these settings.");
  } catch (error) {
    await store(previous);
    await syncServerProxy(ctx, log).catch(() => {});
    throw error;
  }
}

/** After Cloudflare's ranges changed: re-apply every server that trusts them. */
export async function syncCloudflareTrusting(log?: Log) {
  const rows = await db.select({ id: schema.server.id, trusted: schema.server.trustedProxies }).from(schema.server);
  const ids = new Set(rows.filter((r) => r.trusted?.cloudflare).map((r) => r.id));
  for (const ctx of await activeServers()) {
    if (!ids.has(ctx.id)) continue;
    try {
      await syncServerProxy(ctx, log);
    } catch (error) {
      log?.(`Proxy sync failed on ${ctx.name}: ${(error as Error).message}`);
    }
  }
}

export async function waitHealthy(ctx: ServerCtx, timeoutMs = 20_000) {
  if ((await proxyStateOf(ctx.id)).kind === "none") return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await getProxyContainer(ctx))?.State.Running && (await proxyHealthy(ctx))) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export type SiteFileInfo = { file: string; kind: "main" | "dashboard" | "service" | "custom" | "other"; serviceId: string | null; size: number; updatedAt: string };

/** Main configuration files (relative to the proxy directory) per kind. */
const MAIN_FILES: Record<RunningKind, string[]> = { nginx: ["nginx.conf", "proxy_params.conf"], caddy: ["caddy/Caddyfile"], traefik: [] };

/** Generated files of the server's proxy kind, newest first. */
export async function listSiteFiles(ctx?: ServerCtx): Promise<SiteFileInfo[]> {
  const c = ctx ?? (await local());
  const { kind } = await proxyStateOf(c.id);
  if (kind === "none") return [];
  const ext = EXT[kind];
  const out: SiteFileInfo[] = [];
  for (const f of (await c.fs.readdir(c.paths.proxySites)).filter((e) => e.endsWith(ext) && !e.startsWith(USER_PREFIX))) {
    const stat = await c.fs.stat(path.posix.join(c.paths.proxySites, f));
    if (!stat || stat.isDirectory) continue;
    const svc = new RegExp(`^svc-(.+)\\${ext}$`).exec(f);
    out.push({
      file: f,
      kind: f === `_dashboard${ext}` ? "dashboard" : svc ? "service" : f === TRAEFIK_CUSTOM ? "custom" : "other",
      serviceId: svc?.[1] ?? null,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    });
  }
  const extras = kind === "nginx" ? ["custom.conf"] : [];
  for (const name of extras) {
    const stat = await c.fs.stat(path.posix.join(c.paths.proxyCustom, name));
    if (stat) out.push({ file: `custom/${name}`, kind: "custom", serviceId: null, size: stat.size, updatedAt: stat.mtime.toISOString() });
  }
  const rank = (f: SiteFileInfo) => (f.kind === "main" ? 0 : f.file === TRAEFIK_BASE ? 1 : f.kind === "dashboard" ? 2 : f.kind === "custom" ? 3 : 4);
  const mains = await Promise.all(
    MAIN_FILES[kind].map(async (name) => {
      const stat = await c.fs.stat(path.posix.join(c.paths.proxy, name));
      return stat && !stat.isDirectory ? { file: `main/${name}`, kind: "main" as const, serviceId: null, size: stat.size, updatedAt: stat.mtime.toISOString() } : null;
    }),
  );
  out.push(...mains.filter((m) => m !== null));
  return out.sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
}

/** Read one generated file by the name `listSiteFiles` returned. */
export async function readSiteFile(ctx: ServerCtx, file: string) {
  const main = /^main\/(nginx\.conf|proxy_params\.conf|caddy\/Caddyfile)$/.exec(file);
  if (main) return ctx.fs.readFile(path.posix.join(ctx.paths.proxy, main[1]));
  const custom = /^custom\/(custom\.conf|server\.conf|extra\.caddy)$/.exec(file);
  if (custom) return ctx.fs.readFile(path.posix.join(ctx.paths.proxyCustom, custom[1]));
  const user = /^custom\/(user-[a-z0-9._-]+\.(conf|caddy))$/.exec(file);
  if (user) return ctx.fs.readFile(path.posix.join(ctx.paths.proxyCustom, user[1]));
  if (!/^[a-zA-Z0-9_.-]+\.(conf|caddy|ya?ml)$/.test(file)) throw new Error("Invalid file name");
  return ctx.fs.readFile(path.posix.join(ctx.paths.proxySites, file));
}

/** Last lines of a proxy container's output (errors go to stderr). */
export async function proxyLogs(ctx?: ServerCtx, tail = 300) {
  const c = ctx ?? (await local());
  const buffer = (await c.docker.getContainer(c.proxyContainer).logs({ stdout: true, stderr: true, tail, timestamps: true })) as unknown as Buffer;
  return demuxDockerBuffer(Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer)))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const m = /^(\d{4}-\d{2}-\d{2}T\S+)\s(.*)$/.exec(line);
      return m ? { time: m[1], text: m[2] } : { text: line };
    });
}

export async function restartProxy(ctx?: ServerCtx) {
  const c = ctx ?? (await local());
  await c.docker.getContainer(c.proxyContainer).restart({ t: 5 });
}

/** Remove the proxy container (and Traefik's page server) of a server. */
export async function removeProxyContainers(ctx: ServerCtx) {
  await removeContainer(ctx, ctx.proxyContainer);
  await removeContainer(ctx, pagesContainer(ctx));
}

/**
 * Before a server changes owner: remove its proxy (its environment may hold the old owner's
 * Cloudflare token) and the certificates Traefik and Caddy issued for the old owner. Throws when
 * the server cannot be reached, so nothing of the old owner is handed over.
 */
export async function clearProxyForNewOwner(ctx: ServerCtx) {
  for (const name of [ctx.proxyContainer, pagesContainer(ctx)])
    await ctx.docker
      .getContainer(name)
      .remove({ force: true })
      .catch((e: { statusCode?: number }) => {
        if (e?.statusCode !== 404) throw e;
      });
  const dirs = ["traefik-data", "caddy-data"];
  try {
    for (const d of dirs) await ctx.fs.rm(path.posix.join(ctx.paths.proxy, d));
  } catch {
    // The proxy ran as root, so a non-root SSH user may not delete its files: Docker can.
    await removeAsRoot(ctx, ctx.paths.proxy, dirs);
  }
  // Cloudflare tokens certbot used for the old owner's certificates.
  await ctx.fs.rm(path.posix.join(ctx.paths.letsencrypt, "serve-cloudflare")).catch(() => removeAsRoot(ctx, ctx.paths.letsencrypt, ["serve-cloudflare"]));
}

/** Deletes folders inside `dir` on the server through a short-lived container. */
async function removeAsRoot(ctx: ServerCtx, dir: string, names: string[]) {
  const { STORAGE_HELPER_IMAGE } = await import("@/server/backups/storage");
  if (!(await imageExists(STORAGE_HELPER_IMAGE, ctx.docker))) await pullImage(STORAGE_HELPER_IMAGE, undefined, null, ctx.docker);
  const c = await ctx.docker.createContainer({
    Image: STORAGE_HELPER_IMAGE,
    Cmd: ["rm", "-rf", "--", ...names.map((n) => `/mnt/dir/${n}`)],
    Labels: { [LABEL.managed]: "true" },
    HostConfig: { Binds: [`${dir}:/mnt/dir`], NetworkMode: "none" },
  });
  try {
    await c.start();
    const { StatusCode } = await c.wait();
    if (StatusCode !== 0) throw new Error(`Could not delete the old proxy data in ${dir}.`);
  } finally {
    await c.remove({ force: true }).catch(() => {});
  }
}

/** Stop a server's proxy and keep it stopped until an admin starts it again. Every site goes offline. */
export async function stopProxy(ctx: ServerCtx) {
  await db.update(schema.server).set({ proxyStopped: true }).where(eq(schema.server.id, ctx.id));
  await ctx.docker
    .getContainer(ctx.proxyContainer)
    .stop({ t: 5 })
    .catch(() => {});
  await ctx.docker
    .getContainer(pagesContainer(ctx))
    .stop({ t: 2 })
    .catch(() => {});
}

/** Start a stopped proxy again and bring its configuration up to date. */
export async function startProxy(ctx: ServerCtx, log?: Log) {
  await db.update(schema.server).set({ proxyStopped: false }).where(eq(schema.server.id, ctx.id));
  try {
    await ensureServerProxy(ctx, log);
    await syncServer(ctx);
  } catch (error) {
    await db.update(schema.server).set({ proxyStopped: true }).where(eq(schema.server.id, ctx.id));
    throw error;
  }
}

/** Rewrite the error pages on every server, for example after the product name changed. Files only; no reload needed. */
export async function refreshErrorPages() {
  for (const ctx of await activeServers()) await writePages(ctx).catch(() => {});
}
