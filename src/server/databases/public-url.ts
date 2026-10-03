import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";

type Service = typeof schema.service.$inferSelect;

/**
 * Where a database is reached from outside: its domain (direct, not through a tunnel) or the
 * server's public IP, on its public port. `verified`: the domain's certificate is issued, so
 * clients can check it. Null when the database has no public port.
 */
export async function databasePublicEndpoint(service: Service, organizationId: string) {
  const cfg = service.database;
  if (!cfg?.publicPort || cfg.publicBind === "127.0.0.1") return null;
  const { serverPublicIp } = await import("@/server/servers/access");
  const direct = !!cfg.domain && !cfg.domainTunnelId;
  const host = direct ? cfg.domain! : await serverPublicIp(service.serverId);
  if (!host) return null;
  // verify-full only once the domain's certificate is issued: the server serves it then.
  let verified = false;
  if (direct && cfg.tls?.enabled) {
    const { certificateCovers } = await import("@/server/ssl/match");
    const certs = await db
      .select({ domains: schema.certificate.domains, provider: schema.certificate.provider, expiresAt: schema.certificate.expiresAt, issuer: schema.certificate.issuer })
      .from(schema.certificate)
      .where(and(eq(schema.certificate.organizationId, organizationId), eq(schema.certificate.serverId, service.serverId), eq(schema.certificate.status, "active")));
    // Only a certificate clients trust (not a Cloudflare origin or other private one).
    const { clientTrusted } = await import("./domain-tls");
    verified = certs.some((c) => clientTrusted(c) && certificateCovers(c.domains, cfg.domain!));
  }
  return { host, port: cfg.publicPort, verified };
}
