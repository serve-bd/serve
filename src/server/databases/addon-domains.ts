import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { DATABASE_DNS_COMMENT } from "@/lib/database-domains";
import type { AddonAccess } from "@/server/services/types";

/**
 * DNS and certificates for a pooler's or replicas' domain: A records to the servers (or the tunnel's
 * record), a certificate on each server, and the old name's records and certificates gone.
 */
export async function syncAddonDomain(
  service: typeof schema.service.$inferSelect,
  before: AddonAccess | null,
  next: AddonAccess | null,
  servers: string[],
  orgId: string,
): Promise<{ warnings: string[]; unreachable: string[] }> {
  const warnings: string[] = [];
  // Servers with a public IP whose port does not answer from outside.
  const unreachable: string[] = [];
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
      // Servers without a public IP are left out: the domain cannot reach them (the caller says so).
      const reachable = (await Promise.all(servers.map(async (id) => ({ id, ip: await serverPublicIp(id).catch(() => null) })))).filter(
        (x): x is { id: string; ip: string } => !!x.ip,
      );
      // A public IP is not enough: behind a router or a cloud firewall the port may not answer from
      // the internet. Tested from another server; one that does not answer stays out of the domain.
      // With an allowlist the test's own address may be refused: the port is not tested then.
      if (next?.port && !next.allow?.length) {
        const { portAnswersFromOutside } = await import("@/server/net/port-probe");
        for (const x of [...reachable]) {
          if ((await portAnswersFromOutside(x.ip, next.port, x.id)) === false) {
            unreachable.push(x.id);
            reachable.splice(reachable.indexOf(x), 1);
          }
        }
      }
      const ips = reachable.map((x) => x.ip);
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
      for (const { id: serverId } of reachable) {
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
  return { warnings, unreachable };
}
