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
import { hostnamePattern } from "@/lib/database-domains";
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
    // Replica servers without a public IP: the domain leads to the others only.
    let unreachable: string[] = [];
    if (data.open) {
      const hostname = data.domain?.replace(/\.$/, "") || null;
      // Domains take their own port: a Cloudflare Tunnel made every client run cloudflared.
      if (hostname && data.via === "tunnel") throw new UserError("Domains use their own port. Cloudflare Tunnels are no longer offered for them.");
      const tunnelMode = false;
      if (hostname) {
        if (!hostnamePattern.test(hostname)) throw new UserError("Enter a domain like pool.example.com.");
        const ownership = await domainOwnership({ id: ctx.org.id, isRoot: ctx.isRoot }, hostname);
        if (!ownership.verified) throw new UserError(ownershipMessage(hostname, ownership));
        await assertNotDashboardHost(ctx, hostname);
        const [web] = await db.select({ id: schema.domain.id }).from(schema.domain).where(eq(schema.domain.hostname, hostname));
        if (web || (await domainTaken(hostname, { serviceId, which }))) throw new UserError("That domain is already in use.");
        // A domain leads to servers' public IPs: one without any reaches nothing.
        const { serverPublicIp } = await import("@/server/servers/access");
        const ips = await Promise.all(servers.map(async (id) => ({ id, ip: await serverPublicIp(id).catch(() => null) })));
        if (!ips.some((x) => x.ip))
          throw new UserError(
            which === "pooler"
              ? "The database's server has no public IP, so a domain cannot reach the pooler."
              : `${servers.length > 1 ? "None of the replica servers has" : "The replica's server has no"} public IP, so a domain cannot reach ${servers.length > 1 ? "them" : "it"}.`,
          );
        unreachable = ips.filter((x) => !x.ip).map((x) => x.id);
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

    // Start the pooler or replicas with the new settings first: the domain's servers are tested
    // through their open port, then DNS follows, then the servers' firewalls.
    const fresh = { ...service, database: nextCfg };
    if (service.status === "running") {
      const { ensurePooler, ensureReplicas } = await import("@/server/databases/addons");
      if (which === "pooler") await ensurePooler(fresh);
      else await ensureReplicas(fresh);
    }
    const { syncAddonDomain } = await import("@/server/databases/addon-domains");
    const sync = await syncAddonDomain(service, before, service.status === "running" ? next : next && { ...next, port: null }, servers, ctx.org.id);
    const warnings = sync.warnings;
    // Servers whose port did not answer from outside: remembered, so the page names them.
    if (next) {
      next.unreachable = sync.unreachable.length ? sync.unreachable : null;
      const saved = which === "pooler" ? { ...nextCfg, pooler: { ...nextCfg.pooler!, public: next } } : { ...nextCfg, replica: { ...nextCfg.replica!, public: next } };
      await db.update(schema.service).set({ database: saved }).where(eq(schema.service.id, serviceId));
    }
    if (sync.unreachable.length) {
      const named = which === "pooler" ? ["the pooler"] : replicas.filter((r) => sync.unreachable.includes(r.serverId)).map((r) => `replica ${r.id}`);
      warnings.push(
        `Port ${next?.port} does not answer from the internet for ${named.join(", ")}: a router or firewall in front of the server blocks it, so ${next?.domain ?? "the domain"} leaves it out. Open the port there and save again.`,
      );
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
    if (unreachable.length) {
      const named = replicas.filter((r) => unreachable.includes(r.serverId)).map((r) => `replica ${r.id}`);
      warnings.push(`${next?.domain} does not reach ${named.join(", ")}: ${named.length === 1 ? "its server has" : "their servers have"} no public IP.`);
    }
    return { warnings, port: next?.port ?? null };
  });
}
