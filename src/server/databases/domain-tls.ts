import path from "node:path";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LABEL } from "@/server/docker/client";
import { newId } from "@/server/id";
import { proxyPaths } from "@/server/paths";
import { enqueue } from "@/server/queue";
import { getServer, type ServerCtx } from "@/server/servers/context";
import { getSettings } from "@/server/settings";
import { cloudflareAccountFor } from "@/server/ssl/certificates";
import { certificateCovers } from "@/server/ssl/match";
import type { DomainCert } from "./options";

/*
 * Databases on a domain: the database publishes its own port and speaks TLS itself, with the
 * domain's certificate, so clients verify it (sslmode=verify-full). Nothing sits in between.
 */

type Service = typeof schema.service.$inferSelect;
type CertRow = typeof schema.certificate.$inferSelect;

/** Where a domain certificate's files appear inside the database container. */
const MOUNT = "/etc/serve-domain-cert";

/**
 * The certificate for a database's domain: one that already covers it on the server (an uploaded
 * wildcard counts), or a new Let's Encrypt one. HTTP validation needs Serve's nginx on port 80;
 * other servers need the domain in a connected Cloudflare account.
 */
/** Publicly trusted certificates last 398 days at most (CA/Browser Forum); a little room for clocks. */
const PUBLIC_MAX_LIFETIME_MS = 400 * 24 * 3600_000;

/**
 * Certificates a database client can trust. A Cloudflare origin certificate is trusted by
 * Cloudflare's proxy only, and database traffic does not go through it (its DNS is "DNS only").
 * One uploaded by hand is caught too: no public authority issues for longer than 398 days, so a
 * certificate valid much longer (origin certificates last 15 years) comes from a private one.
 */
export const clientTrusted = (c: { provider: string; expiresAt?: Date | null }) =>
  c.provider !== "cloudflare-origin" && !(c.expiresAt && c.expiresAt.getTime() - Date.now() > PUBLIC_MAX_LIFETIME_MS);

export async function ensureDatabaseCertificate(hostname: string, serverId: string, organizationId: string): Promise<CertRow | { error: string }> {
  const certs = await db
    .select()
    .from(schema.certificate)
    .where(and(eq(schema.certificate.organizationId, organizationId), eq(schema.certificate.serverId, serverId)));
  const existing = certs.find((c) => clientTrusted(c) && certificateCovers(c.domains, hostname));
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

/**
 * Binds for one certificate's files, so the container sees that certificate and no other.
 * Let's Encrypt keeps links in live/<id> to files in archive/<id>: both are bound, at the same
 * relative places, so the links resolve.
 */
export function domainCertMount(ctx: ServerCtx, cert: Pick<CertRow, "id" | "certPath" | "keyPath">): DomainCert | null {
  if (!cert.certPath || !cert.keyPath) return null;
  const le = `${proxyPaths.letsencrypt}/live/${cert.id}/`;
  if (cert.certPath.startsWith(le) && cert.keyPath.startsWith(le)) {
    return {
      binds: [
        `${path.posix.join(ctx.paths.letsencrypt, "live", cert.id)}:${MOUNT}/live/${cert.id}:ro`,
        `${path.posix.join(ctx.paths.letsencrypt, "archive", cert.id)}:${MOUNT}/archive/${cert.id}:ro`,
      ],
      cert: `${MOUNT}/live/${cert.id}/${path.posix.basename(cert.certPath)}`,
      key: `${MOUNT}/live/${cert.id}/${path.posix.basename(cert.keyPath)}`,
    };
  }
  const own = `${proxyPaths.certs}/${cert.id}/`;
  if (cert.certPath.startsWith(own) && cert.keyPath.startsWith(own)) {
    return {
      binds: [`${path.posix.join(ctx.paths.certs, cert.id)}:${MOUNT}/${cert.id}:ro`],
      cert: `${MOUNT}/${cert.id}/${path.posix.basename(cert.certPath)}`,
      key: `${MOUNT}/${cert.id}/${path.posix.basename(cert.keyPath)}`,
    };
  }
  return null;
}

/** The active certificate a database serves for its domain, mounted for its container. Null without one. */
export async function databaseDomainCert(ctx: ServerCtx, service: Service): Promise<DomainCert | null> {
  const cfg = service.database;
  if (!cfg?.domain || cfg.domainTunnelId || !cfg.tls?.enabled) return null;
  const [project] = await db.select({ organizationId: schema.project.organizationId }).from(schema.project).where(eq(schema.project.id, service.projectId));
  if (!project) return null;
  const certs = await db
    .select()
    .from(schema.certificate)
    .where(and(eq(schema.certificate.organizationId, project.organizationId), eq(schema.certificate.serverId, ctx.id), eq(schema.certificate.status, "active")));
  const cert = certs.find((c) => clientTrusted(c) && certificateCovers(c.domains, cfg.domain!));
  return cert ? domainCertMount(ctx, cert) : null;
}

/**
 * After a certificate is issued or renewed: databases on its server whose domain it covers load it.
 * A container that already has it mounted restarts (its start step copies the files again);
 * one without it is deployed again to mount it.
 */
export async function refreshDatabaseCertificates(serverId: string, names: string[], organizationId: string) {
  await refreshAddonCertificates(serverId, names, organizationId).catch(() => {});
  const rows = (
    await db
      .select({ service: schema.service })
      .from(schema.service)
      .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
      .where(
        and(
          eq(schema.project.organizationId, organizationId),
          eq(schema.service.serverId, serverId),
          eq(schema.service.type, "database"),
          isNull(schema.service.parentServiceId),
          sql`coalesce(${schema.service.database}->>'domain', '') <> ''`,
          sql`coalesce(${schema.service.database}->>'domainTunnelId', '') = ''`,
        ),
      )
  ).map((r) => r.service);
  const affected = rows.filter((s) => s.database?.domain && s.database.tls?.enabled && certificateCovers(names, s.database.domain));
  if (!affected.length) return;
  const ctx = await getServer(serverId);
  const { queueDeployment } = await import("@/server/services/create");
  for (const service of affected) {
    // The database's own container: not its pooler or a replica (they share the service label).
    const [running] = await ctx.docker.listContainers({ all: false, filters: { label: [`${LABEL.service}=${service.id}`, `${LABEL.kind}=database`] } });
    const mounted = (running?.Mounts ?? []).map((m) => m.Destination).filter((d) => d.startsWith(MOUNT));
    // Another certificate may cover the domain now: a restart would keep serving the old one.
    const want = await databaseDomainCert(ctx, service);
    const current = !want || want.binds.every((b) => mounted.includes(b.split(":")[1]));
    if (running && mounted.length && current) {
      await ctx.docker
        .getContainer(running.Id)
        .restart({ t: 10 })
        .catch(() => {});
    } else if (service.status !== "stopped" && service.status !== "idle") {
      await queueDeployment(service.id, "redeploy");
    }
  }
}

/**
 * A free port for a database's public port, from its engine's port + 10000 up: not published by
 * another container, not saved for another database on the server, and not used by a program on
 * the machine itself (a system PostgreSQL, for example).
 */
export async function freePublicPort(service: Service, enginePort: number) {
  const { freePortOn } = await import("./public-ports");
  return freePortOn(service, [service.serverId], "database", enginePort + 10000);
}

/** The active certificate on a server covering a hostname, mounted for a container. Null without one. */
export async function activeCertMount(ctx: ServerCtx, organizationId: string, hostname: string): Promise<DomainCert | null> {
  const certs = await db
    .select()
    .from(schema.certificate)
    .where(and(eq(schema.certificate.organizationId, organizationId), eq(schema.certificate.serverId, ctx.id), eq(schema.certificate.status, "active")));
  const cert = certs.find((c) => clientTrusted(c) && certificateCovers(c.domains, hostname));
  return cert ? domainCertMount(ctx, cert) : null;
}

/** A pooler or replicas serving a domain the certificate covers, on its server: started again, which loads it. */
async function refreshAddonCertificates(serverId: string, names: string[], organizationId: string) {
  const { replicaInstances } = await import("@/server/services/types");
  const rows = await db
    .select({ service: schema.service })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(and(eq(schema.project.organizationId, organizationId), eq(schema.service.type, "database"), eq(schema.service.status, "running")));
  const { ensurePooler, ensureReplicas } = await import("./addons");
  for (const { service } of rows) {
    const cfg = service.database;
    const pooler = cfg?.pooler?.enabled ? cfg.pooler.public : null;
    if (pooler?.domain && !pooler.tunnelId && service.serverId === serverId && certificateCovers(names, pooler.domain)) await ensurePooler(service);
    const replicas = cfg?.replica?.public;
    if (replicas?.domain && certificateCovers(names, replicas.domain) && replicaInstances(service).some((r) => r.serverId === serverId)) await ensureReplicas(service);
  }
}
