"use server";

import { and, eq, ne, sql } from "drizzle-orm";
import { act, UserError } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { serviceInOrg } from "@/server/services/access";
import { assertNotDashboardHost, domainOwnership, ownershipMessage } from "@/server/domains/ownership";
import { ensureDatabaseCertificate, freePublicPort } from "@/server/databases/domain-tls";
import { engines } from "@/server/databases/engines";
import { queueDeployment } from "@/server/services/create";
import { cloudflareAccountFor } from "@/server/ssl/certificates";
import { Cloudflare } from "@/server/cloudflare/api";
import { serverPublicIp } from "@/server/servers/access";
import { logActivity } from "@/server/activity";
import { hostnamePattern } from "@/lib/database-domains";

/** Marks the DNS records Serve creates for database domains, so it only ever removes its own. */
const DNS_COMMENT = "Serve database domain";

/**
 * Put a database on a domain (or take it off with null). Directly: the database gets its own public
 * port and speaks TLS itself with a certificate for the domain, and restarts to load it. When the
 * domain is in a connected Cloudflare account, its DNS record is created too (DNS only: Cloudflare's
 * proxy does not carry database traffic). Through a tunnel: Cloudflare carries it, no port is opened.
 */
export async function saveDatabaseDomain(serviceId: string, raw: string | null, via: "direct" | "tunnel" = "direct") {
  return act(async () => {
    const ctx = await requirePermission("domains.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    const cfg = service.database;
    if (service.type !== "database" || !cfg) throw new UserError("Only databases get a database domain.");
    if (service.parentServiceId) throw new UserError("Preview databases cannot have a domain.");
    const hostname = raw?.trim().toLowerCase().replace(/\.$/, "") || null;
    const tunnelMode = !!hostname && via === "tunnel";
    const engine = engines[cfg.engine];
    if (hostname && !tunnelMode && !engine.tlsArgs) throw new UserError(`Serve cannot turn on TLS for ${engine.label}. Use a Cloudflare Tunnel for its domain.`);
    const previousTunnel = cfg.domainTunnelId ?? null;
    const previousHost = cfg.domain ?? null;
    const warnings: string[] = [];

    if (hostname) {
      if (!hostnamePattern.test(hostname)) throw new UserError("Enter a domain like db.example.com.");
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

    // Directly on the domain: its own port, open to everyone, with TLS on.
    const direct = !!hostname && !tunnelMode;
    const publicPort = direct ? (cfg.publicPort ?? (await freePublicPort(service, engine.port))) : cfg.publicPort;
    const next = {
      ...cfg,
      domain: hostname,
      domainTunnelId: tunnel?.id ?? null,
      ...(direct ? { publicPort, publicBind: "0.0.0.0" as const, tls: { enabled: true, mode: cfg.tls?.mode ?? ("prefer" as const) } } : {}),
    };
    await db.update(schema.service).set({ database: next, updatedAt: new Date() }).where(eq(schema.service.id, service.id));

    const { syncTunnelIngress } = await import("@/server/cloudflare/tunnels");
    if (tunnel && tunnelAccount && hostname) {
      try {
        const cf = await Cloudflare.forAccount(tunnelAccount);
        const zone = await cf.zoneFor(hostname);
        if (zone) await cf.upsertTunnelRecord(zone.id, hostname, tunnel.cfTunnelId, DNS_COMMENT);
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
              const record = await cf.upsertARecord(zone.id, hostname, ip, false, DNS_COMMENT);
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
    // A domain given up: remove the DNS records Serve made for it (never anyone else's).
    if (previousHost && previousHost !== hostname) {
      const accountId = await cloudflareAccountFor([previousHost], ctx.org.id).catch(() => null);
      if (accountId)
        try {
          const cf = await Cloudflare.forAccount(accountId);
          const zone = await cf.zoneFor(previousHost);
          if (zone) for (const r of await cf.dnsRecords(zone.id, { name: previousHost })) if (r.comment === DNS_COMMENT) await cf.deleteDnsRecord(zone.id, r.id);
        } catch (e) {
          warnings.push(`The DNS record of ${previousHost} was not removed: ${(e as Error).message}`);
        }
    }
    // The container serves the domain's certificate and port itself: start it again with them.
    const containerChanged = direct || (!!previousHost && !previousTunnel);
    if (containerChanged && service.status !== "idle") await queueDeployment(service.id, "redeploy", { userId: ctx.user.id });
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      projectId: service.projectId,
      action: "database.domain",
      targetType: "service",
      targetId: service.id,
      message: hostname ? `Put ${service.name} on ${hostname}${tunnelMode ? " through a Cloudflare Tunnel" : ""}` : `Took ${service.name} off its domain`,
    });
    return { warnings, port: direct ? publicPort : null };
  });
}
