import fs from "node:fs/promises";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { demuxDockerBuffer, docker, ensureNetwork, execInContainer, imageExists, LABEL, pullImage } from "@/server/docker/client";
import { env } from "@/server/env";
import { paths, proxyPaths } from "@/server/paths";
import { getSettings } from "@/server/settings";
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

async function writeIfChanged(file: string, content: string): Promise<boolean> {
  try {
    if ((await fs.readFile(file, "utf8")) === content) return false;
  } catch {
    // missing
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return true;
}

/** Serialize reloads so concurrent deploys never race each other. */
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

const customFile = () => path.join(paths.proxyCustom, "custom.conf");

function customContent(config: string | null) {
  return config?.trim() ? `# Managed by Serve — custom directives from Server → Proxy.\n${config.trim()}\n` : null;
}

/** Write (or remove) the custom http-level config file. Returns true when it changed. */
async function writeCustomConfig(config: string | null) {
  const content = customContent(config);
  if (content) return writeIfChanged(customFile(), content);
  try {
    await fs.rm(customFile());
    return true;
  } catch {
    return false;
  }
}

async function writeStaticFiles() {
  const settings = await getSettings();
  let changed = false;
  changed = (await writeIfChanged(path.join(paths.proxy, "nginx.conf"), mainConfig({ maxBodySize: settings.proxyMaxBodySize }))) || changed;
  changed = (await writeIfChanged(path.join(paths.proxy, "proxy_params.conf"), proxyParams)) || changed;
  for (const [name, html] of Object.entries(pages)) {
    changed = (await writeIfChanged(path.join(paths.proxy, "pages", name), html)) || changed;
  }
  await fs.mkdir(paths.proxySites, { recursive: true });
  changed = (await writeCustomConfig(settings.proxyCustomConfig)) || changed;
  await fs.mkdir(paths.proxyLogs, { recursive: true });
  await fs.mkdir(paths.acme, { recursive: true });
  await fs.mkdir(paths.letsencrypt, { recursive: true });
  await fs.mkdir(paths.certs, { recursive: true });
  return changed;
}

export async function getProxyContainer() {
  try {
    const info = await docker.getContainer(env.proxyContainer).inspect();
    return info;
  } catch {
    return null;
  }
}

/** Create (or repair) the nginx proxy container. */
export async function ensureProxy(log?: (line: string) => void) {
  await ensureNetwork();
  const changed = await writeStaticFiles();
  let info = await getProxyContainer();

  if (!info) {
    if (!(await imageExists(PROXY_IMAGE))) {
      log?.(`Pulling ${PROXY_IMAGE}`);
      await pullImage(PROXY_IMAGE, log);
    }
    const container = await docker.createContainer({
      name: env.proxyContainer,
      Image: PROXY_IMAGE,
      Labels: { [LABEL.managed]: "true", [LABEL.kind]: "proxy" },
      ExposedPorts: { "80/tcp": {}, "443/tcp": {} },
      HostConfig: {
        RestartPolicy: { Name: "unless-stopped" },
        NetworkMode: env.network,
        PortBindings: {
          "80/tcp": [{ HostPort: String(env.proxyHttpPort) }],
          "443/tcp": [{ HostPort: String(env.proxyHttpsPort) }],
        },
        ExtraHosts: ["host.docker.internal:host-gateway"],
        Binds: [
          `${path.join(paths.proxy, "nginx.conf")}:/etc/nginx/nginx.conf:ro`,
          `${path.join(paths.proxy, "proxy_params.conf")}:/etc/nginx/serve/proxy_params.conf:ro`,
          `${path.join(paths.proxy, "pages")}:${proxyPaths.pages}:ro`,
          `${paths.proxySites}:${proxyPaths.sites}:ro`,
          `${paths.acme}:${proxyPaths.acme}:ro`,
          `${paths.letsencrypt}:${proxyPaths.letsencrypt}:ro`,
          `${paths.certs}:${proxyPaths.certs}:ro`,
          `${paths.proxyLogs}:${proxyPaths.logs}`,
        ],
        LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
      },
    });
    await container.start();
    await connectProxyToAll();
    log?.("Proxy container started");
    info = await getProxyContainer();
  } else if (!info.State.Running) {
    await docker.getContainer(env.proxyContainer).start();
    log?.("Proxy container restarted");
  } else if (changed) {
    await reloadProxy();
  }
  return info;
}

export class ProxyConfigError extends Error {}

/** Validate config and gracefully reload nginx. */
export async function reloadProxy() {
  const test = await execInContainer(env.proxyContainer, ["nginx", "-t"]);
  if (test.exitCode !== 0) throw new ProxyConfigError(test.output.trim());
  const reload = await execInContainer(env.proxyContainer, ["nginx", "-s", "reload"]);
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
async function appTargets(service: typeof schema.service.$inferSelect): Promise<string[]> {
  if (!service.currentDeploymentId) return [];
  const containers = await docker.listContainers({
    all: false,
    filters: {
      label: [`${LABEL.service}=${service.id}`, `${LABEL.deployment}=${service.currentDeploymentId}`],
    },
  });
  return containers.map((c) => c.Names[0].replace(/^\//, "")).sort();
}

export async function renderServiceSite(serviceId: string): Promise<string | null> {
  const service = await db.query.service.findFirst({
    where: eq(schema.service.id, serviceId),
    with: { domains: true, project: { columns: { organizationId: true } } },
  });
  if (!service || service.type === "database" || service.domains.length === 0) return null;

  // Only certificates owned by the same organization can be used.
  const certs = await db
    .select()
    .from(schema.certificate)
    .where(eq(schema.certificate.organizationId, service.project.organizationId));
  const upstreams = new Map<string, SiteUpstream>();
  const servers: SiteServer[] = [];
  const stopped = service.status === "stopped";

  const containers = service.type === "app" && !stopped ? await appTargets(service) : [];

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

async function renderDashboardSite(): Promise<string | null> {
  const settings = await getSettings();
  if (!settings.dashboardDomain) return null;
  const certs = settings.rootOrganizationId
    ? await db.select().from(schema.certificate).where(eq(schema.certificate.organizationId, settings.rootOrganizationId))
    : [];
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

const siteFile = (name: string) => path.join(paths.proxySites, `${name}.conf`);

/**
 * Apply a set of site file changes atomically: write, test, reload, and roll back
 * every file if nginx rejects the new configuration.
 */
async function applySites(changes: Map<string, string | null>) {
  const previous = new Map<string, string | null>();
  let dirty = false;
  for (const [file, content] of changes) {
    let old: string | null = null;
    try {
      old = await fs.readFile(file, "utf8");
    } catch {
      old = null;
    }
    if (old === content) continue;
    previous.set(file, old);
    dirty = true;
    if (content === null) await fs.rm(file, { force: true });
    else await fs.writeFile(file, content);
  }
  if (!dirty) return false;
  if (!(await getProxyContainer())?.State.Running) return true;
  try {
    await reloadProxy();
  } catch (error) {
    for (const [file, old] of previous) {
      if (old === null) await fs.rm(file, { force: true });
      else await fs.writeFile(file, old);
    }
    throw error;
  }
  return true;
}

export function syncServiceProxy(serviceId: string) {
  return serialized(async () => {
    await fs.mkdir(paths.proxySites, { recursive: true });
    const [svc] = await db.select({ environmentId: schema.service.environmentId }).from(schema.service).where(eq(schema.service.id, serviceId));
    if (svc) await connectProxy(envNetworkName(svc.environmentId)).catch(() => {});
    const content = await renderServiceSite(serviceId);
    await applySites(new Map([[siteFile(`svc-${serviceId}`), content]]));
  });
}

export function removeServiceProxy(serviceId: string) {
  return serialized(() => applySites(new Map([[siteFile(`svc-${serviceId}`), null]])));
}

/** Regenerate every site file, removing stale ones. */
export function syncAllProxy() {
  return serialized(async () => {
    const staticChanged = await writeStaticFiles();
    const changes = new Map<string, string | null>();
    const existing = await fs.readdir(paths.proxySites).catch(() => [] as string[]);
    for (const f of existing) if (f.endsWith(".conf")) changes.set(path.join(paths.proxySites, f), null);

    const services = await db
      .select({ id: schema.service.id })
      .from(schema.service)
      .where(inArray(schema.service.type, ["app", "compose"]));
    for (const s of services) {
      changes.set(siteFile(`svc-${s.id}`), await renderServiceSite(s.id));
    }
    changes.set(siteFile("_dashboard"), await renderDashboardSite());
    const reloaded = await applySites(changes);
    if (staticChanged && !reloaded && (await getProxyContainer())?.State.Running) await reloadProxy();
  });
}

export function syncDashboardProxy() {
  return serialized(async () => {
    await applySites(new Map([[siteFile("_dashboard"), await renderDashboardSite()]]));
  });
}

/** Services whose domains use a given certificate (explicitly or by hostname). */
export async function servicesUsingCertificate(cert: CertRow): Promise<string[]> {
  const domains = (
    await db
      .select({ domain: schema.domain })
      .from(schema.domain)
      .innerJoin(schema.service, eq(schema.domain.serviceId, schema.service.id))
      .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
      .where(eq(schema.project.organizationId, cert.organizationId))
  ).map((r) => r.domain);
  return [
    ...new Set(
      domains
        .filter((d) => d.certificateId === cert.id || certificateCovers(cert.domains, d.hostname))
        .map((d) => d.serviceId),
    ),
  ];
}

export async function proxyStatus() {
  const info = await getProxyContainer();
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

/** Run `nginx -t` in the proxy container. */
export async function testProxyConfig() {
  if (!(await getProxyContainer())?.State.Running) return { ok: false, output: "The proxy is not running." };
  const res = await execInContainer(env.proxyContainer, ["nginx", "-t"]).catch((e: Error) => ({ exitCode: 1, output: e.message }));
  return { ok: res.exitCode === 0, output: res.output.trim() };
}

/**
 * Validate and apply custom http-level directives. On failure the previous file is
 * restored and the nginx error is thrown, so nothing changes.
 */
export function applyCustomConfig(config: string | null) {
  return serialized(async () => {
    let previous: string | null = null;
    try {
      previous = await fs.readFile(customFile(), "utf8");
    } catch {
      previous = null;
    }
    const content = customContent(config);
    if (content === previous) return;
    if (content) {
      await fs.mkdir(paths.proxyCustom, { recursive: true });
      await fs.writeFile(customFile(), content);
    } else await fs.rm(customFile(), { force: true });
    if (!(await getProxyContainer())?.State.Running) return;
    try {
      await reloadProxy();
    } catch (error) {
      if (previous === null) await fs.rm(customFile(), { force: true });
      else await fs.writeFile(customFile(), previous);
      throw error;
    }
  });
}

export type SiteFileInfo = { file: string; kind: "dashboard" | "service" | "custom" | "other"; serviceId: string | null; size: number; updatedAt: string };

/** Generated site files, newest first. */
export async function listSiteFiles(): Promise<SiteFileInfo[]> {
  const out: SiteFileInfo[] = [];
  const entries = await fs.readdir(paths.proxySites).catch(() => [] as string[]);
  for (const f of entries.filter((e) => e.endsWith(".conf"))) {
    const stat = await fs.stat(path.join(paths.proxySites, f)).catch(() => null);
    if (!stat?.isFile()) continue;
    const svc = /^svc-(.+)\.conf$/.exec(f);
    out.push({
      file: f,
      kind: f === "_dashboard.conf" ? "dashboard" : svc ? "service" : "other",
      serviceId: svc?.[1] ?? null,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    });
  }
  const custom = await fs.stat(customFile()).catch(() => null);
  if (custom) out.push({ file: "custom/custom.conf", kind: "custom", serviceId: null, size: custom.size, updatedAt: custom.mtime.toISOString() });
  return out.sort((a, b) => (a.kind === "dashboard" ? -1 : b.kind === "dashboard" ? 1 : b.updatedAt.localeCompare(a.updatedAt)));
}

/** Read one site file by the name `listSiteFiles` returned. */
export async function readSiteFile(file: string) {
  if (file === "custom/custom.conf") return fs.readFile(customFile(), "utf8");
  if (!/^[a-zA-Z0-9_.-]+\.conf$/.test(file)) throw new Error("Invalid file name");
  return fs.readFile(path.join(paths.proxySites, file), "utf8");
}

/** Last lines of the proxy container's output (nginx errors go to stderr). */
export async function proxyLogs(tail = 300) {
  const buffer = (await docker.getContainer(env.proxyContainer).logs({ stdout: true, stderr: true, tail, timestamps: true })) as unknown as Buffer;
  return demuxDockerBuffer(Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer)))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const m = /^(\d{4}-\d{2}-\d{2}T\S+)\s(.*)$/.exec(line);
      return m ? { time: m[1], text: m[2] } : { text: line };
    });
}

export async function restartProxy() {
  await docker.getContainer(env.proxyContainer).restart({ t: 5 });
}
