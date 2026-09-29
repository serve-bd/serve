import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LOCAL_SERVER_ID } from "@/server/db/schema";
import { demuxDockerBuffer, ensureNetwork, execInContainer, imageExists, LABEL, pullImage } from "@/server/docker/client";
import { env } from "@/server/env";
import { proxyPaths } from "@/server/paths";
import { getSettings } from "@/server/settings";
import { getServer, listServers, type ServerCtx } from "@/server/servers/context";
import {
  mainConfig,
  pages,
  PROXY_IMAGE,
  proxyParams,
  serverBlocks,
  upstreamBlock,
  type SiteServer,
  type SiteUpstream,
} from "./templates";
import { certificateCovers } from "@/server/ssl/match";
import { composeAlias } from "./names";
import { connectProxy, connectProxyToAll, envNetworkName } from "@/server/docker/networks";

/**
 * nginx proxies, one per server. Every server has its own `serve-proxy`
 * container with config files in its data directory; all reads and writes go
 * through the server's ServerCtx, so local and remote proxies share this code.
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

function customContent(config: string | null) {
  return config?.trim() ? `# Managed by Serve — custom directives from Server → Proxy.\n${config.trim()}\n` : null;
}

/** Write (or remove) the custom http-level config file. Returns true when it changed. */
async function writeCustomConfig(ctx: ServerCtx, config: string | null) {
  const content = customContent(config);
  if (content) return ctx.fs.writeIfChanged(customFile(ctx), content);
  if (!(await ctx.fs.exists(customFile(ctx)))) return false;
  await ctx.fs.rm(customFile(ctx));
  return true;
}

async function writeStaticFiles(ctx: ServerCtx) {
  const settings = await getSettings();
  const p = ctx.paths;
  let changed = false;
  // If the proxy container started before these files existed (fresh data directory),
  // Docker created directories in their place. Replace them with the real files.
  for (const file of ["nginx.conf", "proxy_params.conf"]) {
    const target = path.posix.join(p.proxy, file);
    if ((await ctx.fs.stat(target))?.isDirectory) {
      await ctx.fs.rm(target);
      changed = true;
    }
  }
  changed = (await ctx.fs.writeIfChanged(path.posix.join(p.proxy, "nginx.conf"), mainConfig({ maxBodySize: settings.proxyMaxBodySize }))) || changed;
  changed = (await ctx.fs.writeIfChanged(path.posix.join(p.proxy, "proxy_params.conf"), proxyParams)) || changed;
  for (const [name, html] of Object.entries(pages)) {
    changed = (await ctx.fs.writeIfChanged(path.posix.join(p.proxy, "pages", name), html)) || changed;
  }
  for (const dir of [p.proxySites, p.proxyLogs, p.acme, p.letsencrypt, p.certs]) await ctx.fs.mkdir(dir);
  changed = (await writeCustomConfig(ctx, settings.proxyCustomConfig)) || changed;
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

/** Create (or repair) the nginx proxy container on a server. */
export async function ensureServerProxy(ctx: ServerCtx, log?: Log) {
  await ensureNetwork(ctx.docker, ctx.network);
  const changed = await writeStaticFiles(ctx);
  let info = await getProxyContainer(ctx);
  const p = ctx.paths;

  if (!info) {
    if (!(await imageExists(PROXY_IMAGE, ctx.docker))) {
      log?.(`Pulling ${PROXY_IMAGE}`);
      await pullImage(PROXY_IMAGE, log, null, ctx.docker);
    }
    const container = await ctx.docker.createContainer({
      name: ctx.proxyContainer,
      Image: PROXY_IMAGE,
      Labels: { [LABEL.managed]: "true", [LABEL.kind]: "proxy" },
      ExposedPorts: { "80/tcp": {}, "443/tcp": {} },
      HostConfig: {
        RestartPolicy: { Name: "unless-stopped" },
        NetworkMode: ctx.network,
        PortBindings: {
          "80/tcp": [{ HostPort: String(ctx.proxyHttpPort) }],
          "443/tcp": [{ HostPort: String(ctx.proxyHttpsPort) }],
        },
        ExtraHosts: ["host.docker.internal:host-gateway"],
        Binds: [
          `${path.posix.join(p.proxy, "nginx.conf")}:/etc/nginx/nginx.conf:ro`,
          `${path.posix.join(p.proxy, "proxy_params.conf")}:/etc/nginx/serve/proxy_params.conf:ro`,
          `${path.posix.join(p.proxy, "pages")}:${proxyPaths.pages}:ro`,
          `${p.proxySites}:${proxyPaths.sites}:ro`,
          `${p.acme}:${proxyPaths.acme}:ro`,
          `${p.letsencrypt}:${proxyPaths.letsencrypt}:ro`,
          `${p.certs}:${proxyPaths.certs}:ro`,
          `${p.proxyLogs}:${proxyPaths.logs}`,
        ],
        LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
      },
    });
    await container.start();
    await connectProxyToAll(ctx);
    log?.("Proxy container started");
    info = await getProxyContainer(ctx);
  } else {
    const ports = info.HostConfig.PortBindings as Record<string, { HostPort?: string }[] | undefined> | undefined;
    const bound = [ports?.["80/tcp"]?.[0]?.HostPort, ports?.["443/tcp"]?.[0]?.HostPort];
    if (bound[0] !== String(ctx.proxyHttpPort) || bound[1] !== String(ctx.proxyHttpsPort)) {
      // Published ports changed in the server settings: recreate the container.
      log?.(`Proxy ports changed to ${ctx.proxyHttpPort}/${ctx.proxyHttpsPort}; recreating the proxy`);
      await ctx.docker.getContainer(ctx.proxyContainer).remove({ force: true });
      return ensureServerProxy(ctx, log);
    }
    if (!info.State.Running) {
      try {
        await ctx.docker.getContainer(ctx.proxyContainer).start();
        log?.("Proxy container restarted");
      } catch (error) {
        // Broken mounts (for example after the data directory was wiped): start over.
        log?.(`Proxy did not start (${(error as Error).message.split(":")[0]}); recreating it`);
        await ctx.docker.getContainer(ctx.proxyContainer).remove({ force: true });
        return ensureServerProxy(ctx, log);
      }
    } else if (changed) {
      await reloadProxy(ctx);
    }
  }
  return info;
}

/** Create (or repair) the proxy of the machine Serve runs on. */
export async function ensureProxy(log?: Log) {
  return ensureServerProxy(await local(), log);
}

export class ProxyConfigError extends Error {}

/** Validate config and gracefully reload nginx on a server. */
export async function reloadProxy(ctx?: ServerCtx) {
  const c = ctx ?? (await local());
  const test = await execInContainer(c.proxyContainer, ["nginx", "-t"], {}, c.docker);
  if (test.exitCode !== 0) throw new ProxyConfigError(test.output.trim());
  const reload = await execInContainer(c.proxyContainer, ["nginx", "-s", "reload"], {}, c.docker);
  if (reload.exitCode !== 0) throw new ProxyConfigError(reload.output.trim());
}

type CertRow = typeof schema.certificate.$inferSelect;

function tlsFor(
  hostname: string,
  explicitId: string | null,
  certs: CertRow[],
): SiteServer["tls"] {
  const usable = certs.filter((c) => c.status === "active" && c.certPath && c.keyPath);
  const cert =
    (explicitId && usable.find((c) => c.id === explicitId)) ||
    usable.find((c) => certificateCovers(c.domains, hostname));
  return cert ? { cert: cert.certPath!, key: cert.keyPath! } : null;
}

const upstreamName = (slug: string, suffix: string) =>
  `svc_${slug}_${suffix}`.replace(/[^a-zA-Z0-9_]/g, "_");

/** Container names currently serving traffic for an app service. */
async function appTargets(ctx: ServerCtx, service: typeof schema.service.$inferSelect): Promise<string[]> {
  if (!service.currentDeploymentId) return [];
  const containers = await ctx.docker.listContainers({
    all: false,
    filters: {
      label: [`${LABEL.service}=${service.id}`, `${LABEL.deployment}=${service.currentDeploymentId}`],
    },
  });
  return containers.map((c) => c.Names[0].replace(/^\//, "")).sort();
}

/** Certificates a site on a server may use: same organization, stored on that server. */
function usableCertificates(organizationId: string, serverId: string) {
  return db
    .select()
    .from(schema.certificate)
    .where(and(eq(schema.certificate.organizationId, organizationId), eq(schema.certificate.serverId, serverId)));
}

export async function renderServiceSite(serviceId: string, ctx?: ServerCtx): Promise<string | null> {
  const service = await db.query.service.findFirst({
    where: eq(schema.service.id, serviceId),
    with: { domains: true, project: { columns: { organizationId: true } } },
  });
  if (!service || service.type === "database" || service.domains.length === 0) return null;
  const server = ctx ?? (await getServer(service.serverId));

  const certs = await usableCertificates(service.project.organizationId, service.serverId);
  const upstreams = new Map<string, SiteUpstream>();
  const servers: SiteServer[] = [];
  const stopped = service.status === "stopped";

  const containers = service.type === "app" && !stopped ? await appTargets(server, service) : [];

  for (const d of service.domains) {
    let upstream: string | null = null;
    if (!d.redirectTo && !stopped) {
      const port = d.port ?? service.runtime.port ?? 80;
      if (service.type === "app") {
        const name = upstreamName(service.slug, String(port));
        if (!upstreams.has(name)) {
          upstreams.set(name, { name, servers: containers.map((c) => `${c}:${port}`) });
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
      redirectTo: d.redirectTo,
      forceHttps: d.forceHttps,
      tls: d.https ? tlsFor(d.hostname, d.certificateId, certs) : null,
    });
  }

  return [
    `# Managed by Serve — service "${service.name}" (${service.id}).`,
    ...[...upstreams.values()].map(upstreamBlock),
    ...servers.map(serverBlocks),
  ].join("\n");
}

export { composeAlias };

/** The dashboard is only served by the proxy of the machine Serve runs on. */
async function renderDashboardSite(): Promise<string | null> {
  const settings = await getSettings();
  if (!settings.dashboardDomain) return null;
  const certs = settings.rootOrganizationId ? await usableCertificates(settings.rootOrganizationId, LOCAL_SERVER_ID) : [];
  const upstream: SiteUpstream = { name: "serve_dashboard", servers: [env.dashboardUpstream] };
  return [
    "# Managed by Serve — dashboard.",
    upstreamBlock(upstream),
    serverBlocks({
      hostname: settings.dashboardDomain,
      upstream: upstream.name,
      forceHttps: true,
      tls: settings.dashboardHttps ? tlsFor(settings.dashboardDomain, null, certs) : null,
      allow: settings.dashboardAllowlist,
    }),
  ].join("\n");
}

const siteFile = (ctx: ServerCtx, name: string) => path.posix.join(ctx.paths.proxySites, `${name}.conf`);

/**
 * Apply a set of site file changes atomically: write, test, reload, and roll back
 * every file if nginx rejects the new configuration.
 */
async function applySites(ctx: ServerCtx, changes: Map<string, string | null>) {
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
    await reloadProxy(ctx);
  } catch (error) {
    for (const [file, old] of previous) {
      if (old === null) await ctx.fs.rm(file);
      else await ctx.fs.writeFile(file, old);
    }
    throw error;
  }
  return true;
}

/** Render the site of one service on the server it runs on. */
export async function syncServiceProxy(serviceId: string) {
  const [svc] = await db
    .select({ environmentId: schema.service.environmentId, serverId: schema.service.serverId })
    .from(schema.service)
    .where(eq(schema.service.id, serviceId));
  const ctx = await getServer(svc?.serverId ?? LOCAL_SERVER_ID);
  return serialized(ctx.id, async () => {
    await ctx.fs.mkdir(ctx.paths.proxySites);
    if (svc) await connectProxy(envNetworkName(svc.environmentId), ctx).catch(() => {});
    const content = await renderServiceSite(serviceId, ctx);
    await applySites(ctx, new Map([[siteFile(ctx, `svc-${serviceId}`), content]]));
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
    const [svc] = await db.select({ serverId: schema.service.serverId }).from(schema.service).where(eq(schema.service.id, serviceId));
    targets = svc ? [await getServer(svc.serverId)] : await activeServers();
  }
  for (const ctx of targets) {
    await serialized(ctx.id, () => applySites(ctx, new Map([[siteFile(ctx, `svc-${serviceId}`), null]]))).catch((error) => {
      if (serverId || targets.length === 1) throw error;
    });
  }
}

/** Regenerate every site file on one server, removing stale ones. */
function syncServer(ctx: ServerCtx) {
  return serialized(ctx.id, async () => {
    const staticChanged = await writeStaticFiles(ctx);
    const changes = new Map<string, string | null>();
    for (const f of await ctx.fs.readdir(ctx.paths.proxySites)) if (f.endsWith(".conf")) changes.set(path.posix.join(ctx.paths.proxySites, f), null);

    const services = await db
      .select({ id: schema.service.id })
      .from(schema.service)
      .where(and(inArray(schema.service.type, ["app", "compose"]), eq(schema.service.serverId, ctx.id)));
    for (const s of services) changes.set(siteFile(ctx, `svc-${s.id}`), await renderServiceSite(s.id, ctx));
    if (ctx.local) changes.set(siteFile(ctx, "_dashboard"), await renderDashboardSite());
    const reloaded = await applySites(ctx, changes);
    if (staticChanged && !reloaded && (await getProxyContainer(ctx))?.State.Running) await reloadProxy(ctx);
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
    await applySites(ctx, new Map([[siteFile(ctx, "_dashboard"), await renderDashboardSite()]]));
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
  return [
    ...new Set(
      domains
        .filter((d) => d.certificateId === cert.id || certificateCovers(cert.domains, d.hostname))
        .map((d) => d.serviceId),
    ),
  ];
}

export async function proxyStatus(ctx?: ServerCtx) {
  const info = await getProxyContainer(ctx).catch(() => null);
  return {
    exists: !!info,
    running: !!info?.State.Running,
    image: info?.Config.Image ?? null,
    startedAt: info?.State.StartedAt ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/*                              Admin inspection                              */
/* -------------------------------------------------------------------------- */

/** Run `nginx -t` in a server's proxy container. */
export async function testProxyConfig(ctx?: ServerCtx) {
  const c = ctx ?? (await local());
  if (!(await getProxyContainer(c))?.State.Running) return { ok: false, output: "The proxy is not running." };
  const res = await execInContainer(c.proxyContainer, ["nginx", "-t"], {}, c.docker).catch((e: Error) => ({ exitCode: 1, output: e.message }));
  return { ok: res.exitCode === 0, output: res.output.trim() };
}

/**
 * Validate and apply custom http-level directives on every active server. If any
 * proxy rejects them, every server gets its previous file back and the nginx
 * error is thrown, so nothing changes.
 */
export async function applyCustomConfig(config: string | null) {
  const servers = await activeServers();
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

export type SiteFileInfo = { file: string; kind: "dashboard" | "service" | "custom" | "other"; serviceId: string | null; size: number; updatedAt: string };

/** Generated site files on a server, newest first. */
export async function listSiteFiles(ctx?: ServerCtx): Promise<SiteFileInfo[]> {
  const c = ctx ?? (await local());
  const out: SiteFileInfo[] = [];
  for (const f of (await c.fs.readdir(c.paths.proxySites)).filter((e) => e.endsWith(".conf"))) {
    const stat = await c.fs.stat(path.posix.join(c.paths.proxySites, f));
    if (!stat || stat.isDirectory) continue;
    const svc = /^svc-(.+)\.conf$/.exec(f);
    out.push({
      file: f,
      kind: f === "_dashboard.conf" ? "dashboard" : svc ? "service" : "other",
      serviceId: svc?.[1] ?? null,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    });
  }
  const custom = await c.fs.stat(customFile(c));
  if (custom) out.push({ file: "custom/custom.conf", kind: "custom", serviceId: null, size: custom.size, updatedAt: custom.mtime.toISOString() });
  return out.sort((a, b) => (a.kind === "dashboard" ? -1 : b.kind === "dashboard" ? 1 : b.updatedAt.localeCompare(a.updatedAt)));
}

/** Read one site file by the name `listSiteFiles` returned. */
export async function readSiteFile(ctx: ServerCtx, file: string) {
  if (file === "custom/custom.conf") return ctx.fs.readFile(customFile(ctx));
  if (!/^[a-zA-Z0-9_.-]+\.conf$/.test(file)) throw new Error("Invalid file name");
  return ctx.fs.readFile(path.posix.join(ctx.paths.proxySites, file));
}

/** Last lines of a proxy container's output (nginx errors go to stderr). */
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
