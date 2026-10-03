import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import { engines } from "@/server/databases/engines";
import { databaseUrl } from "@/server/databases/options";
import { publishedPorts } from "@/server/services/ports";
import { serverPublicIp } from "@/server/servers/access";
import { dashboardVisitorIp } from "@/server/proxy/trusted-proxies";
import { certificateCovers } from "@/server/ssl/match";
import { replicaInstances } from "@/server/services/types";
import { inRanges } from "@/lib/trusted-proxies";
import { privateHost } from "@/lib/hostname";
import { tunnelTargetPort } from "@/lib/database-domains";

type Service = typeof schema.service.$inferSelect;

/**
 * What the Public access page shows for a database: its own public port and domain, and for
 * PostgreSQL its pooler's and replicas'. Built for the viewer: URLs are masked for roles that may
 * not see secrets.
 */
export async function databaseAccessView(service: Service, org: { id: string; can: (p: string) => boolean }) {
  const cfg = service.database!;
  const engine = engines[cfg.engine];
  const [published] = await publishedPorts(service);
  const hideSecrets = !org.can("variables.view-secrets");
  const creds = { username: cfg.username, password: hideSecrets ? "********" : (decryptOrNull(cfg.password) ?? ""), database: cfg.database };
  const certs = await db
    .select({ status: schema.certificate.status, error: schema.certificate.lastError, domains: schema.certificate.domains, serverId: schema.certificate.serverId })
    .from(schema.certificate)
    .where(eq(schema.certificate.organizationId, org.id));
  const certFor = (hostname: string, serverId: string) =>
    certs.filter((c) => c.serverId === serverId && certificateCovers(c.domains, hostname)).sort((a, b) => Number(b.status === "active") - Number(a.status === "active"))[0];
  const hostname = cfg.domain ?? null;
  const domainCert = hostname ? certFor(hostname, service.serverId) : undefined;
  // Tunnels of this server: a domain can go through one instead of a public port (no public IP needed).
  const tunnels = await db
    .select({ id: schema.cloudflareTunnel.id, account: schema.cloudflareAccount.name })
    .from(schema.cloudflareTunnel)
    .innerJoin(schema.cloudflareAccount, eq(schema.cloudflareTunnel.cloudflareAccountId, schema.cloudflareAccount.id))
    .where(and(eq(schema.cloudflareTunnel.serverId, service.serverId), eq(schema.cloudflareAccount.organizationId, org.id)));
  const localPort = tunnelTargetPort(cfg.engine, engine.port);
  const direct = !!hostname && !cfg.domainTunnelId;
  const publicIp = await serverPublicIp(service.serverId).catch(() => null);
  const domain = service.parentServiceId
    ? undefined
    : {
        supported: !!engine.tlsArgs || tunnels.length > 0,
        directSupported: !!engine.tlsArgs,
        // With a public IP, a domain on its own port needs nothing on the computers that connect.
        publicIp,
        allow: cfg.publicAllow ?? [],
        via: cfg.domainTunnelId ? ("tunnel" as const) : ("direct" as const),
        tunnels: tunnels.map((t) => ({ id: t.id, label: `Tunnel of ${t.account}` })),
        tunnelCommand: hostname ? `cloudflared access tcp --hostname ${hostname} --url localhost:${localPort}` : null,
        localUrl: databaseUrl(cfg, creds, "localhost", localPort),
        hostname,
        port: direct ? (cfg.publicPort ?? null) : null,
        url: direct && cfg.publicPort ? databaseUrl(cfg, creds, hostname, cfg.publicPort, { public: true, verified: domainCert?.status === "active" && !!cfg.tls?.enabled }) : null,
        // Public access or TLS turned off after the domain was set: the domain does not answer.
        unreachable: direct && (!cfg.publicPort || cfg.publicBind === "127.0.0.1" || !cfg.tls?.enabled),
        certificate: domainCert ? { status: domainCert.status, error: domainCert.error } : null,
        engine: cfg.engine,
        engineLabel: engine.label,
      };
  // Offered for allowlists (not on a dashboard opened at localhost).
  const ip = await dashboardVisitorIp(await headers());
  const viewerIp = ip && !inRanges(ip, ["127.0.0.0/8", "::1/128"]) ? ip : null;

  /** A pooler's or the replicas' public side, for their card. */
  const addon = (which: "pooler" | "replicas") => {
    const pub = which === "pooler" ? cfg.pooler?.public : cfg.replica?.public;
    const servers = which === "pooler" ? [service.serverId] : [...new Set(replicaInstances(service).map((r) => r.serverId))];
    const host = pub?.domain || (pub?.port ? publicIp : null);
    const url = pub?.port && host && !pub.tunnelId ? databaseUrl(cfg, creds, host, pub.port, { public: true, verified: !!pub.domain }) : null;
    return {
      open: !!pub,
      port: pub?.port ?? null,
      bind: pub?.bind ?? ("0.0.0.0" as const),
      allow: pub?.allow ?? [],
      domain: pub?.domain ?? null,
      via: pub?.tunnelId ? ("tunnel" as const) : ("direct" as const),
      tunnelCommand: pub?.domain && pub.tunnelId ? `cloudflared access tcp --hostname ${pub.domain} --url localhost:5432` : null,
      url,
      certificates: pub?.domain && !pub.tunnelId ? servers.map((id) => ({ serverId: id, status: certFor(pub.domain!, id)?.status ?? "missing" })) : [],
      servers: servers.length,
    };
  };
  const postgres = cfg.engine === "postgres" && !service.parentServiceId;
  return {
    hideSecrets,
    viewerIp,
    engine: { label: engine.label, port: engine.port },
    database: {
      publicPort: cfg.publicPort ?? null,
      publicBind: cfg.publicBind ?? ("0.0.0.0" as const),
      publicAllow: cfg.publicAllow ?? [],
      publicUrl: published ? databaseUrl(cfg, creds, published.address, published.host, { public: true }) : null,
      publicAddress: published?.label ?? null,
    },
    domain,
    tunnels: tunnels.map((t) => ({ id: t.id, label: `Tunnel of ${t.account}` })),
    pooler: postgres && cfg.pooler?.enabled ? addon("pooler") : null,
    replicas: postgres && replicaInstances(service).length ? addon("replicas") : null,
    privateHost: privateHost(service),
  };
}

export type DatabaseAccessView = Awaited<ReturnType<typeof databaseAccessView>>;
