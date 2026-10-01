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
export async function saveDatabaseDomain(serviceId: string, raw: string | null) {
  return act(async () => {
    const ctx = await requirePermission("domains.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    const cfg = service.database;
    if (service.type !== "database" || !cfg) throw new UserError("Only databases get a database domain.");
    if (service.parentServiceId) throw new UserError("Preview databases cannot have a domain.");
    if (!DOMAIN_ROUTES[cfg.engine]) throw new UserError("MySQL and MariaDB cannot share a port by domain. Use Public access with its own port instead.");
    const hostname = raw?.trim().toLowerCase().replace(/\.$/, "") || null;
    const warnings: string[] = [];

    if (hostname) {
      if (!hostnamePattern.test(hostname)) throw new UserError("Enter a domain like db.example.com.");
      if (cfg.tls?.enabled && cfg.tls.mode === "require")
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

    await db
      .update(schema.service)
      .set({ database: { ...cfg, domain: hostname }, updatedAt: new Date() })
      .where(eq(schema.service.id, service.id));

    if (hostname) {
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
      message: hostname ? `Put ${service.name} on ${hostname}` : `Took ${service.name} off its domain`,
    });
    return { warnings };
  });
}
