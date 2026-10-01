"use server";

import { and, eq, ne, sql } from "drizzle-orm";
import { act, UserError } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { serviceInOrg } from "@/server/services/access";
import { assertNotDashboardHost, domainOwnership, ownershipMessage } from "@/server/domains/ownership";
import { ensureDatabaseCertificate, queueRouterSync } from "@/server/databases/router";
import { cloudflareAccountFor } from "@/server/ssl/certificates";
import { Cloudflare } from "@/server/cloudflare/api";
import { serverPublicIp } from "@/server/servers/access";
import { logActivity } from "@/server/activity";
import { DOMAIN_ROUTES, hostnamePattern } from "@/lib/database-domains";

/**
 * Put a database on a domain (or take it off with null): the server's database router answers
 * for it on the engine's usual port, over TLS, with a certificate for the domain. When the domain
 * is in a connected Cloudflare account, its DNS record is created too (DNS only: Cloudflare's
 * proxy does not carry database traffic).
 */
export async function saveDatabaseDomain(serviceId: string, raw: string | null, via: "router" | "tunnel" = "router") {
  return act(async () => {
    const ctx = await requirePermission("domains.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    const cfg = service.database;
    if (service.type !== "database" || !cfg) throw new UserError("Only databases get a database domain.");
    if (service.parentServiceId) throw new UserError("Preview databases cannot have a domain.");
    const hostname = raw?.trim().toLowerCase().replace(/\.$/, "") || null;
    const tunnelMode = !!hostname && via === "tunnel";
    // A tunnel carries any TCP: only the router needs a name in the TLS handshake.
    if (!tunnelMode && !DOMAIN_ROUTES[cfg.engine])
      throw new UserError("MySQL and MariaDB cannot share a port by domain. Use a Cloudflare Tunnel, or Public access with its own port.");
    const previousTunnel = cfg.domainTunnelId ?? null;
    const warnings: string[] = [];

    if (hostname) {
      if (!hostnamePattern.test(hostname)) throw new UserError("Enter a domain like db.example.com.");
      if (!tunnelMode && cfg.tls?.enabled && cfg.tls.mode === "require")
        throw new UserError("Turn off “Require TLS” for this database first: the domain already requires TLS, and the router reaches the database over the private network.");
      const [web] = await db.select({ id: schema.domain.id }).from(schema.domain).where(eq(schema.domain.hostname, hostname));
      if (web) throw new UserError("That domain is already used by a website or app.");
      const [other] = await db
        .select({ name: schema.service.name })
        .from(schema.service)
        .where(and(ne(schema.service.id, service.id), eq(schema.service.type, "database"), sql`lower(${schema.service.database}->>'domain') = ${hostname}`));
      if (other) throw new UserError(`${other.name} already uses that domain.`);
      await assertNotDashboardHost(ctx, hostname);
      const ownership = await domainOwnership({ id: ctx.org.id, isRoot: ctx.isRoot }, hostname);
      if (!ownership.verified) throw new UserError(ownershipMessage(hostname, ownership));
    }

    // Through a tunnel: one of this server's tunnels, of the Cloudflare account that holds the domain.
    let tunnel: typeof schema.cloudflareTunnel.$inferSelect | null = null;
    let tunnelAccount: string | null = null;
    if (tunnelMode && hostname) {
      tunnelAccount = await cloudflareAccountFor([hostname], ctx.org.id);
      if (!tunnelAccount) throw new UserError(`${hostname} is not in a connected Cloudflare account. A tunnel needs the domain's zone in Cloudflare.`);
      [tunnel] = await db
        .select()
        .from(schema.cloudflareTunnel)
        .where(and(eq(schema.cloudflareTunnel.serverId, service.serverId), eq(schema.cloudflareTunnel.cloudflareAccountId, tunnelAccount)));
      if (!tunnel) throw new UserError("This server has no Cloudflare Tunnel for that account. Create one in Integrations → Cloudflare first.");
    }

    await db
      .update(schema.service)
      .set({ database: { ...cfg, domain: hostname, domainTunnelId: tunnel?.id ?? null }, updatedAt: new Date() })
      .where(eq(schema.service.id, service.id));

    const { syncTunnelIngress } = await import("@/server/cloudflare/tunnels");
    if (tunnel && tunnelAccount && hostname) {
      try {
        const cf = await Cloudflare.forAccount(tunnelAccount);
        const zone = await cf.zoneFor(hostname);
        if (zone) await cf.upsertTunnelRecord(zone.id, hostname, tunnel.cfTunnelId);
      } catch (e) {
        warnings.push(`DNS record not created: ${(e as Error).message}`);
      }
      await syncTunnelIngress(tunnel.id).catch((e) => warnings.push(`Tunnel route not saved: ${(e as Error).message}`));
    }
    if (previousTunnel && previousTunnel !== tunnel?.id) await syncTunnelIngress(previousTunnel).catch(() => {});

    if (hostname && !tunnelMode) {
      // DNS: an A record to the server, when Cloudflare holds the zone.
      const accountId = await cloudflareAccountFor([hostname], ctx.org.id);
      if (accountId) {
        const ip = await serverPublicIp(service.serverId);
        if (!ip) warnings.push("Set the public IP of this server so the DNS record can point at it.");
        else
          try {
            const cf = await Cloudflare.forAccount(accountId);
            const zone = await cf.zoneFor(hostname);
            if (zone) {
              const record = await cf.upsertARecord(zone.id, hostname, ip, false, "Serve database domain");
              if (!record)
                warnings.push(`${hostname} already has an A record for this server. Make sure it is DNS only (grey cloud): Cloudflare's proxy does not carry database traffic.`);
            }
          } catch (e) {
            warnings.push(`DNS record not created: ${(e as Error).message}`);
          }
      } else {
        warnings.push(`Point ${hostname} at this server's IP with an A record. If it is in Cloudflare, keep it DNS only (grey cloud).`);
      }
      const cert = await ensureDatabaseCertificate(hostname, service.serverId, ctx.org.id);
      if ("error" in cert) warnings.push(cert.error);
    }
    await queueRouterSync(service.serverId);
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      projectId: service.projectId,
      action: "database.domain",
      targetType: "service",
      targetId: service.id,
      message: hostname ? `Put ${service.name} on ${hostname}${tunnelMode ? " through a Cloudflare Tunnel" : ""}` : `Took ${service.name} off its domain`,
    });
    return { warnings };
  });
}
