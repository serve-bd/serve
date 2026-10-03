"use server";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { logActivity } from "@/server/activity";
import { serviceInOrg } from "@/server/services/access";
import { type AddonAccess, hasHostAccess, replicaInstances } from "@/server/services/types";
import { assertNotDashboardHost, domainOwnership, ownershipMessage } from "@/server/domains/ownership";
import { DATABASE_DNS_COMMENT, hostnamePattern } from "@/lib/database-domains";
import { normalizeTrustedRanges } from "@/lib/trusted-proxies";

type Which = "pooler" | "replicas";

const accessSchema = z.object({
  open: z.boolean(),
  /** Empty: a free one is picked. */
  port: z.number().int().min(1024).max(65535).nullable().optional(),
  bind: z.enum(["0.0.0.0", "127.0.0.1"]).optional(),
  allow: z.array(z.string().max(100)).max(200).nullable().optional(),
  domain: z.string().trim().toLowerCase().max(253).nullable().optional(),
  /** The pooler only: carry the domain through this server's Cloudflare Tunnel instead of a port. */
  via: z.enum(["direct", "tunnel"]).optional(),
});

/** Every database, pooler and replica domain in use, but `self`'s own. */
async function domainTaken(hostname: string, self: { serviceId: string; which: Which }) {
  const rows = await db
    .select({ id: schema.service.id, database: schema.service.database })
    .from(schema.service)
    .where(
      and(
        eq(schema.service.type, "database"),
        sql`(lower(${schema.service.database}->>'domain') = ${hostname}
          OR lower(${schema.service.database}->'pooler'->'public'->>'domain') = ${hostname}
          OR lower(${schema.service.database}->'replica'->'public'->>'domain') = ${hostname})`,
      ),
    );
  return rows.some((r) => {
    const cfg = r.database;
    if (cfg?.domain?.toLowerCase() === hostname) return true;
    if (cfg?.pooler?.public?.domain?.toLowerCase() === hostname && !(r.id === self.serviceId && self.which === "pooler")) return true;
    if (cfg?.replica?.public?.domain?.toLowerCase() === hostname && !(r.id === self.serviceId && self.which === "replicas")) return true;
    return false;
  });
}

/**
 * Public access for a PostgreSQL database's pooler or read replicas: a public port (TLS only),
 * who may reach it, and a domain. The pooler's port and domain are on the database's server
 * (or its domain goes through a Cloudflare Tunnel); the replicas share one port on each server a
 * replica runs on, and their domain leads to all of those servers. The database itself is not
 * touched; the pooler or replicas start again with the new settings.
 */
export async function setAddonAccess(serviceId: string, which: Which, input: z.input<typeof accessSchema>) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    if (!ctx.can("domains.manage")) throw new UserError("Public access needs the right to manage domains.");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    const cfg = service.database;
    if (cfg?.engine !== "postgres") throw new UserError("Public access for a pooler or replicas is for PostgreSQL databases.");
    if (service.parentServiceId) throw new UserError("Preview databases have no public access.");
    if (hasHostAccess(service.runtime) && !(ctx.isInstanceAdmin && ctx.isRoot))
      throw new UserError("Changing a database that has host-level access is only available to admins of the Root organization, for its own services.");
    if (which === "pooler" && !cfg.pooler?.enabled) throw new UserError("Turn on connection pooling first.");
    const replicas = replicaInstances(service);
    if (which === "replicas" && !replicas.length) throw new UserError("Add a read replica first.");
    const data = accessSchema.parse(input);
    const before: AddonAccess | null = (which === "pooler" ? cfg.pooler?.public : cfg.replica?.public) ?? null;
    const servers = which === "pooler" ? [service.serverId] : [...new Set(replicas.map((r) => r.serverId))];

    let next: AddonAccess | null = null;
    if (data.open) {
      const hostname = data.domain?.replace(/\.$/, "") || null;
      const tunnelMode = !!hostname && data.via === "tunnel";
      if (tunnelMode && which !== "pooler") throw new UserError("Replicas on several servers take their domain directly, not through a tunnel.");
      if (hostname) {
        if (!hostnamePattern.test(hostname)) throw new UserError("Enter a domain like pool.example.com.");
        const ownership = await domainOwnership({ id: ctx.org.id, isRoot: ctx.isRoot }, hostname);
        if (!ownership.verified) throw new UserError(ownershipMessage(hostname, ownership));
        await assertNotDashboardHost(ctx, hostname);
        const [web] = await db.select({ id: schema.domain.id }).from(schema.domain).where(eq(schema.domain.hostname, hostname));
        if (web || (await domainTaken(hostname, { serviceId, which }))) throw new UserError("That domain is already in use.");
      }
      let allow: string[] | null = null;
      if (data.allow?.length) {
        const r = normalizeTrustedRanges(data.allow, { anyWidth: true });
        if ("error" in r) throw new UserError(r.error);
        allow = r.ranges.length ? r.ranges : null;
      }
      let tunnelId: string | null = null;
      if (tunnelMode && hostname) {
        const { cloudflareAccountFor } = await import("@/server/ssl/certificates");
        const account = await cloudflareAccountFor([hostname], ctx.org.id);
        if (!account) throw new UserError(`${hostname} is not in a connected Cloudflare account. A tunnel needs the domain's zone in Cloudflare.`);
        const [tunnel] = await db
          .select({ id: schema.cloudflareTunnel.id })
          .from(schema.cloudflareTunnel)
          .where(and(eq(schema.cloudflareTunnel.serverId, service.serverId), eq(schema.cloudflareTunnel.cloudflareAccountId, account)));
        if (!tunnel) throw new UserError("This server has no Cloudflare Tunnel for that account. Create one in Integrations → Cloudflare first.");
        tunnelId = tunnel.id;
      }
      // The port: through a tunnel none is needed. A chosen one must be free on every server it opens on.
      let port: number | null = null;
      if (!tunnelMode) {
        const { busyPortsFor, freePortOn } = await import("@/server/databases/public-ports");
        const holder = which === "pooler" ? "pooler" : "replicas";
        if (data.port) {
          for (const serverId of servers) {
            const busy = await busyPortsFor(service, serverId, holder);
            // Its own current port is busy because it is open now.
            if (busy.has(data.port) && data.port !== before?.port) throw new UserError(`Port ${data.port} is already used on one of the servers.`);
          }
          port = data.port;
        } else port = before?.port ?? (await freePortOn(service, servers, holder, which === "pooler" ? 16432 : 17432));
      }
      next = { port, bind: data.bind ?? "0.0.0.0", allow, domain: hostname, tunnelId };
    }

    const nextCfg = which === "pooler" ? { ...cfg, pooler: { ...cfg.pooler!, public: next } } : { ...cfg, replica: { ...cfg.replica!, enabled: true, public: next } };
    await db.update(schema.service).set({ database: nextCfg, updatedAt: new Date() }).where(eq(schema.service.id, serviceId));

    const warnings = await syncDomain(service, before, next, servers, ctx.org.id);
    // Start the pooler or replicas again with the new settings, then their servers' firewalls.
    const fresh = { ...service, database: nextCfg };
    if (service.status === "running") {
      const { ensurePooler, ensureReplicas } = await import("@/server/databases/addons");
      if (which === "pooler") await ensurePooler(fresh);
      else await ensureReplicas(fresh);
    }
    const { applyDatabaseAllowlists } = await import("@/server/databases/allowlist");
    for (const serverId of servers) await applyDatabaseAllowlists(serverId).catch((e) => warnings.push(`Firewall not updated: ${(e as Error).message}`));
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      projectId: service.projectId,
      action: "database.domain",
      targetType: "service",
      targetId: service.id,
      message: `${which === "pooler" ? "Pooler" : "Read replicas"} of ${service.name}: ${next ? `public${next.port ? ` on port ${next.port}` : ""}${next.domain ? ` at ${next.domain}` : ""}` : "private"}`,
    });
    return { warnings, port: next?.port ?? null };
  });
}

/**
 * DNS and certificates for a pooler's or replicas' domain: A records to the servers (or the tunnel's
 * record), a certificate on each server, and the old name's records and certificates gone.
 */
async function syncDomain(service: typeof schema.service.$inferSelect, before: AddonAccess | null, next: AddonAccess | null, servers: string[], orgId: string) {
  const warnings: string[] = [];
  const { cloudflareAccountFor, retireCertificateFor } = await import("@/server/ssl/certificates");
  const { Cloudflare } = await import("@/server/cloudflare/api");
  const { syncTunnelIngress } = await import("@/server/cloudflare/tunnels");
  const host = next?.domain ?? null;
  if (host) {
    const accountId = await cloudflareAccountFor([host], orgId);
    if (next?.tunnelId) {
      const [tunnel] = await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.id, next.tunnelId));
      try {
        const cf = await Cloudflare.forAccount(accountId!);
        const zone = await cf.zoneFor(host);
        if (zone && tunnel) await cf.upsertTunnelRecord(zone.id, host, tunnel.cfTunnelId, DATABASE_DNS_COMMENT);
      } catch (e) {
        warnings.push(`DNS record not created: ${(e as Error).message}`);
      }
      await syncTunnelIngress(next.tunnelId).catch((e) => warnings.push(`Tunnel route not saved: ${(e as Error).message}`));
    } else {
      const { serverPublicIp } = await import("@/server/servers/access");
      const ips = (await Promise.all(servers.map((id) => serverPublicIp(id)))).filter((ip): ip is string => !!ip);
      if (ips.length < servers.length) warnings.push("Set the public IP of each server so the DNS records can point at it.");
      if (accountId && ips.length) {
        try {
          const cf = await Cloudflare.forAccount(accountId);
          const zone = await cf.zoneFor(host);
          if (zone) await cf.setARecords(zone.id, host, ips, DATABASE_DNS_COMMENT);
        } catch (e) {
          warnings.push(`DNS records not created: ${(e as Error).message}`);
        }
      } else if (!accountId) {
        warnings.push(
          `Point ${host} at ${servers.length > 1 ? "each replica server's IP with an A record" : "this server's IP with an A record"}. If it is in Cloudflare, keep it DNS only (grey cloud).`,
        );
      }
      const { ensureDatabaseCertificate } = await import("@/server/databases/domain-tls");
      for (const serverId of servers) {
        const cert = await ensureDatabaseCertificate(host, serverId, orgId);
        if ("error" in cert) warnings.push(cert.error);
      }
    }
  }
  // The previous name: its tunnel route, records and certificates go when the name changed or moved.
  const old = before?.domain ?? null;
  if (before?.tunnelId && before.tunnelId !== next?.tunnelId) await syncTunnelIngress(before.tunnelId).catch(() => {});
  if (old && (old !== host || (!before?.tunnelId && next?.tunnelId))) {
    for (const serverId of new Set([service.serverId, ...servers])) await retireCertificateFor(old, serverId, orgId).catch(() => {});
  }
  if (old && old !== host) {
    const accountId = await cloudflareAccountFor([old], orgId).catch(() => null);
    if (accountId)
      try {
        const cf = await Cloudflare.forAccount(accountId);
        const zone = await cf.zoneFor(old);
        if (zone) for (const r of await cf.dnsRecords(zone.id, { name: old })) if (r.comment === DATABASE_DNS_COMMENT) await cf.deleteDnsRecord(zone.id, r.id);
      } catch (e) {
        warnings.push(`The DNS records of ${old} were not removed: ${(e as Error).message}`);
      }
  }
  return warnings;
}
