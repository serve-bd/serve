import crypto from "node:crypto";
import path from "node:path";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LABEL } from "@/server/docker/client";
import { connectProxy, envNetworkName } from "@/server/docker/networks";
import { newId } from "@/server/id";
import { enqueue } from "@/server/queue";
import { getServer, type ServerCtx } from "@/server/servers/context";
import { getSettings } from "@/server/settings";
import { certificateFor } from "@/server/proxy/model";
import { ensureImage } from "@/server/proxy/nginx";
import { proxyImages } from "@/server/proxy/config";
import { proxyPaths } from "@/server/paths";
import { cloudflareAccountFor } from "@/server/ssl/certificates";
import { certificateCovers } from "@/server/ssl/match";
import { privateHost } from "@/lib/hostname";
import { DOMAIN_ROUTES } from "@/lib/database-domains";

export const ROUTER_CONTAINER = "serve-db-router";
const SPEC_LABEL = "serve.db-router.spec";
const routerDir = (ctx: ServerCtx) => path.posix.join(ctx.paths.proxy, "db-router");
const inContainer = "/etc/serve-db-router";

type Service = typeof schema.service.$inferSelect;
type CertRow = typeof schema.certificate.$inferSelect;

/** Database services of a server that have a domain, with their organization. */
async function domainDatabases(serverId: string) {
  return db
    .select({ service: schema.service, organizationId: schema.project.organizationId })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(
      and(
        eq(schema.service.serverId, serverId),
        eq(schema.service.type, "database"),
        isNull(schema.service.parentServiceId),
        sql`coalesce(${schema.service.database}->>'domain', '') <> ''`,
      ),
    );
}

/**
 * The certificate for a database's domain: one that already covers it on the server (an uploaded
 * wildcard counts), or a new Let's Encrypt one. HTTP validation needs Serve's nginx on port 80;
 * other servers need the domain in a connected Cloudflare account. Returns null when neither works.
 */
export async function ensureDatabaseCertificate(hostname: string, serverId: string, organizationId: string): Promise<CertRow | { error: string }> {
  const certs = await db
    .select()
    .from(schema.certificate)
    .where(and(eq(schema.certificate.organizationId, organizationId), eq(schema.certificate.serverId, serverId)));
  const existing = certs.find((c) => certificateCovers(c.domains, hostname));
  if (existing) {
    if (existing.status === "failed" && existing.provider !== "custom")
      await enqueue("certificate.issue", { certificateId: existing.id }, { concurrencyKey: `cert:${existing.id}` });
    return existing;
  }
  const settings = await getSettings();
  if (!settings.acmeEmail) return { error: "Set the Let's Encrypt email in Settings, or upload a certificate for this domain." };
  const cloudflareAccountId = await cloudflareAccountFor([hostname], organizationId);
  const [server] = await db.select({ kind: schema.server.proxyKind }).from(schema.server).where(eq(schema.server.id, serverId));
  if (!cloudflareAccountId && server?.kind !== "nginx")
    return { error: "This server's proxy is not nginx, so Let's Encrypt cannot check the domain over HTTP. Connect the domain's Cloudflare account, or upload a certificate." };
  const id = newId();
  const [cert] = await db
    .insert(schema.certificate)
    .values({
      id,
      organizationId,
      serverId,
      name: hostname,
      domains: [hostname],
      provider: cloudflareAccountId ? "letsencrypt-cloudflare" : "letsencrypt-http",
      cloudflareAccountId,
      status: "pending",
    })
    .returning();
  await enqueue("certificate.issue", { certificateId: id }, { concurrencyKey: `cert:${id}`, maxAttempts: 2 });
  return cert;
}

/** Host ports other containers on the server already publish. */
async function busyPorts(ctx: ServerCtx, ports: number[]) {
  const busy = new Set<number>();
  for (const c of await ctx.docker.listContainers({ all: false })) {
    if (c.Names.some((n) => n === `/${ROUTER_CONTAINER}`)) continue;
    for (const p of c.Ports ?? []) if (p.PublicPort && ports.includes(p.PublicPort)) busy.add(p.PublicPort);
  }
  return busy;
}

export type RouterState = { routes: { serviceId: string; hostname: string; ok: boolean; reason: string | null }[]; busyPorts: number[] };

/**
 * Bring the server's database router in line with its databases' domains: write its routes,
 * publish the ports in use, join the networks of those databases, and remove it when no
 * database has a domain.
 */
export async function syncDatabaseRouter(serverId: string): Promise<RouterState> {
  const ctx = await getServer(serverId);
  const rows = await domainDatabases(serverId);
  const certs = rows.length
    ? await db
        .select()
        .from(schema.certificate)
        .where(and(eq(schema.certificate.serverId, serverId), inArray(schema.certificate.organizationId, [...new Set(rows.map((r) => r.organizationId))])))
    : [];

  const state: RouterState = { routes: [], busyPorts: [] };
  type Route = { name: string; entry: string; hostname: string; address: string; alpn?: string[]; cert: { cert: string; key: string } };
  const routes: Route[] = [];
  for (const { service, organizationId } of rows) {
    const cfg = service.database;
    const hostname = cfg?.domain?.trim().toLowerCase();
    const spec = cfg ? DOMAIN_ROUTES[cfg.engine] : undefined;
    if (!cfg || !hostname || !spec) continue;
    const tls = certificateFor(
      hostname,
      null,
      certs.filter((c) => c.organizationId === organizationId),
    );
    if (!tls) {
      state.routes.push({ serviceId: service.id, hostname, ok: false, reason: "Waiting for a certificate" });
      continue;
    }
    for (const r of spec) routes.push({ name: `${service.id}-${r.entry}`, entry: r.entry, hostname, address: `${privateHost(service)}:${r.target}`, alpn: r.alpn, cert: tls });
    state.routes.push({ serviceId: service.id, hostname, ok: true, reason: null });
  }

  if (!routes.length) {
    await ctx.docker
      .getContainer(ROUTER_CONTAINER)
      .remove({ force: true })
      .catch(() => {});
    return state;
  }

  // Ports of the engines in use, unless something else on the server already has them.
  const entries = new Map<string, number>();
  for (const spec of Object.values(DOMAIN_ROUTES)) for (const r of spec ?? []) entries.set(r.entry, r.port);
  const wanted = [...new Set(routes.map((r) => entries.get(r.entry) as number))];
  const busy = await busyPorts(ctx, wanted);
  state.busyPorts = [...busy];
  const ports = wanted.filter((p) => !busy.has(p));

  // Static config: every entry point; only the used ones get a published port.
  const staticConfig = {
    entryPoints: Object.fromEntries([...entries].map(([name, port]) => [name, { address: `:${port}` }])),
    providers: { file: { directory: `${inContainer}/dynamic`, watch: true } },
    log: { level: "ERROR" },
  };
  const alpnOptions = new Map<string, string[]>();
  for (const r of routes) if (r.alpn) alpnOptions.set(r.alpn.join("-"), r.alpn);
  const dynamic = {
    tcp: {
      routers: Object.fromEntries(
        routes.map((r) => [r.name, { entryPoints: [r.entry], rule: `HostSNI(\`${r.hostname}\`)`, service: r.name, tls: r.alpn ? { options: r.alpn.join("-") } : {} }]),
      ),
      services: Object.fromEntries(routes.map((r) => [r.name, { loadBalancer: { servers: [{ address: r.address }] } }])),
    },
    tls: {
      ...(alpnOptions.size ? { options: Object.fromEntries([...alpnOptions].map(([name, alpn]) => [name, { alpnProtocols: alpn }])) } : {}),
      certificates: [...new Map(routes.map((r) => [r.cert.cert, { certFile: r.cert.cert, keyFile: r.cert.key }])).values()],
    },
  };
  const dir = routerDir(ctx);
  await ctx.fs.mkdir(path.posix.join(dir, "dynamic"));
  // JSON is YAML too; Traefik reads both from .yml files.
  await ctx.fs.writeIfChanged(path.posix.join(dir, "traefik.yml"), JSON.stringify(staticConfig, null, 2));
  await ctx.fs.writeIfChanged(path.posix.join(dir, "dynamic", "databases.yml"), JSON.stringify(dynamic, null, 2));

  const image = proxyImages.traefik;
  const binds = [`${dir}:${inContainer}:ro`, `${ctx.paths.letsencrypt}:${proxyPaths.letsencrypt}:ro`, `${ctx.paths.certs}:${proxyPaths.certs}:ro`];
  const portBindings = Object.fromEntries(ports.map((p) => [`${p}/tcp`, [{ HostPort: String(p) }]]));
  const specHash = crypto.createHash("sha256").update(JSON.stringify({ image, binds, portBindings })).digest("hex").slice(0, 16);
  const info = await ctx.docker
    .getContainer(ROUTER_CONTAINER)
    .inspect()
    .catch(() => null);
  if (!info || info.Config.Labels?.[SPEC_LABEL] !== specHash || !info.State.Running) {
    if (info)
      await ctx.docker
        .getContainer(ROUTER_CONTAINER)
        .remove({ force: true })
        .catch(() => {});
    await ensureImage(ctx, image);
    const container = await ctx.docker.createContainer({
      name: ROUTER_CONTAINER,
      Image: image,
      Cmd: [`--configFile=${inContainer}/traefik.yml`],
      Labels: { [LABEL.managed]: "true", [LABEL.kind]: "db-router", [SPEC_LABEL]: specHash },
      ExposedPorts: Object.fromEntries(ports.map((p) => [`${p}/tcp`, {}])),
      HostConfig: {
        RestartPolicy: { Name: "unless-stopped" },
        NetworkMode: ctx.network,
        PortBindings: portBindings,
        Binds: binds,
        LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
      },
    });
    for (const env of new Set(rows.map((r) => r.service.environmentId)))
      await connectProxy(envNetworkName(env), { docker: ctx.docker, proxyContainer: ROUTER_CONTAINER, id: ctx.id }).catch(() => {});
    await container.start();
  } else {
    for (const env of new Set(rows.map((r) => r.service.environmentId)))
      await connectProxy(envNetworkName(env), { docker: ctx.docker, proxyContainer: ROUTER_CONTAINER, id: ctx.id }).catch(() => {});
  }
  return state;
}

/**
 * After a certificate is issued or renewed: sync the server's router when one of its database
 * domains uses it. A renewal keeps the file paths, which the router does not re-read, so it restarts.
 */
export async function refreshDatabaseRouter(serverId: string, names: string[]) {
  const rows = await domainDatabases(serverId);
  if (!rows.some((r) => r.service.database?.domain && certificateCovers(names, r.service.database.domain))) return;
  const ctx = await getServer(serverId);
  const before = await ctx.docker
    .getContainer(ROUTER_CONTAINER)
    .inspect()
    .catch(() => null);
  await syncDatabaseRouter(serverId);
  const after = await ctx.docker
    .getContainer(ROUTER_CONTAINER)
    .inspect()
    .catch(() => null);
  // Same container as before: the certificate files changed underneath it.
  if (before && after && before.Id === after.Id) await ctx.docker.getContainer(ROUTER_CONTAINER).restart({ t: 2 });
}

/** Worker tick: every server whose databases have domains, plus routers left without any. */
export async function syncAllDatabaseRouters() {
  const rows = await db
    .selectDistinct({ serverId: schema.service.serverId })
    .from(schema.service)
    .where(and(eq(schema.service.type, "database"), isNotNull(schema.service.database), sql`coalesce(${schema.service.database}->>'domain', '') <> ''`));
  for (const { serverId } of rows) await syncDatabaseRouter(serverId).catch((e) => console.error(`[db-router] ${serverId}: ${(e as Error).message}`));
}

export const queueRouterSync = (serverId: string) => enqueue("dbrouter.sync", { serverId }, { concurrencyKey: `dbrouter:${serverId}`, maxAttempts: 2 });

export type { Service };
