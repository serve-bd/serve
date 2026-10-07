import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LABEL } from "@/server/docker/client";
import { LOCAL_SERVER_ID } from "@/server/db/schema";
import { env } from "@/server/env";
import { getSettings } from "@/server/settings";
import type { ServerCtx } from "@/server/servers/context";
import type { ServiceProxyConfig } from "@/server/services/proxy-config";
import { bestCertificate } from "@/server/ssl/match";
import { maintenanceOf, type ProxyMaintenance } from "@/server/services/maintenance";
import { gateUpstream } from "@/server/gate";
import { gateOn } from "@/server/services/proxy-config";
import { composeAlias, tunnelNetworkName } from "./names";
import { BALANCE_CONNECT_TIMEOUT, localTargets, remoteTargets } from "@/server/services/balance";

/**
 * Proxy-agnostic description of one site (a service with domains, or the
 * dashboard). The Caddy and Traefik drivers render it; nginx keeps its own
 * renderer so existing configs stay byte-for-byte identical.
 */
export type HostModel = {
  hostname: string;
  /** Key into SiteModel.upstreams; null for redirects and stopped services. */
  upstream: string | null;
  redirectTo: string | null;
  /** The domain wants HTTPS (and the proxy terminates TLS). */
  https: boolean;
  forceHttps: boolean;
  /** Routed through a Cloudflare Tunnel: served over plain HTTP, Cloudflare terminates TLS. */
  tunnel: boolean;
  /** A certificate Serve manages for this host (paths inside the proxy container). */
  tls: { cert: string; key: string } | null;
  /** Extra allowlist (dashboard). */
  allow?: string[];
};

export type SiteModel = {
  /** File base name: svc-<id> or _dashboard. */
  name: string;
  title: string;
  serviceId: string | null;
  stopped: boolean;
  /**
   * `weights`: one per target, when they differ (an app's copies on other servers count their
   * replicas). `remote`: some targets are on other servers (load balancing): a target that fails is
   * skipped for a while instead of being tried by every request.
   */
  upstreams: { key: string; targets: string[]; weights?: number[]; remote?: boolean }[];
  hosts: HostModel[];
  options: ServiceProxyConfig | null;
  /** Maintenance page on every host (except redirects). */
  maintenance?: ProxyMaintenance | null;
  /** Comment lines naming the certificates served (certificateStamp). */
  certificates?: string[];
  /** Login wall: where this proxy reaches Serve (gateUpstream). */
  gate?: { upstream: string } | null;
};

type CertRow = typeof schema.certificate.$inferSelect;

export function certificateFor(hostname: string, explicitId: string | null, certs: CertRow[]) {
  const usable = certs.filter((c) => c.status === "active" && c.certPath && c.keyPath);
  const cert = (explicitId && usable.find((c) => c.id === explicitId)) || bestCertificate(hostname, usable);
  return cert ? { cert: cert.certPath!, key: cert.keyPath! } : null;
}

/**
 * Comment lines naming each certificate a site serves and when it expires. A renewal writes the
 * same files, so without them the site would not change and the proxy would keep the old certificate.
 */
export function certificateStamp(certs: CertRow[], used: ({ cert: string } | null | undefined)[]) {
  const paths = new Set(used.flatMap((t) => (t ? [t.cert] : [])));
  return certs.filter((c) => c.certPath && paths.has(c.certPath)).map((c) => `# Certificate ${c.id} valid until ${c.expiresAt?.toISOString() ?? "unknown"}.`);
}

export function orgCertificates(organizationId: string, serverId: string) {
  return db
    .select()
    .from(schema.certificate)
    .where(and(eq(schema.certificate.organizationId, organizationId), eq(schema.certificate.serverId, serverId)));
}

/** Container names currently serving traffic for an app service on one server. */
export async function appTargets(ctx: ServerCtx, service: typeof schema.service.$inferSelect) {
  if (!service.currentDeploymentId) return [];
  const running = await ctx.docker.listContainers({ all: false, filters: { label: [`${LABEL.service}=${service.id}`] } });
  const apps = running.filter((c) => c.Labels[LABEL.kind] !== "predeploy");
  let serving = apps.filter((c) => c.Labels[LABEL.deployment] === service.currentDeploymentId);
  // An extra server whose last deploy failed keeps its previous version; keep routing to it.
  if (!serving.length && ctx.id !== service.serverId) serving = apps;
  return serving.map((c) => c.Names[0].replace(/^\//, "")).sort();
}

export async function serviceModel(serviceId: string, ctx: ServerCtx): Promise<SiteModel | null> {
  const service = await db.query.service.findFirst({
    where: eq(schema.service.id, serviceId),
    with: { domains: true, project: { columns: { organizationId: true } } },
  });
  if (!service || service.type === "database" || service.domains.length === 0) return null;
  // Certificates live on the server that serves them; extra servers use their own (or plain HTTP / the proxy's ACME).
  const certs = await orgCertificates(service.project.organizationId, ctx.id);
  const stopped = service.status === "stopped";
  const containers = service.type === "app" && !stopped ? await appTargets(ctx, service) : [];
  let cfg = service.proxy ?? null;
  const upstreams = new Map<string, { targets: string[]; weights?: number[]; remote?: boolean }>();
  const hostnames = new Set(service.domains.map((d) => d.hostname));

  const wwwTarget = (hostname: string) => {
    if (!cfg?.wwwRedirect || cfg.wwwRedirect === "none") return null;
    const other = cfg.wwwRedirect === "to-apex" ? (hostname.startsWith("www.") ? hostname.slice(4) : null) : hostname.startsWith("www.") ? null : `www.${hostname}`;
    if (!other || !hostnames.has(other)) return null;
    const target = service.domains.find((d) => d.hostname === other)!;
    return `${target.https || target.tunnelId ? "https" : "http"}://${other}`;
  };

  const hosts: HostModel[] = [];
  for (const d of service.domains) {
    let upstream: string | null = null;
    if (!d.redirectTo && !stopped) {
      const port = d.port ?? service.runtime.port ?? 80;
      if (service.type === "app") {
        upstream = `app-${port}`;
        if (!upstreams.has(upstream)) {
          // The app's copies on its extra servers, when this is its own server (load balancing).
          const remote = await remoteTargets(service, ctx.id, containers.length, port);
          const local = localTargets(service, containers, remote.length).map((c) => `${c}:${port}`);
          upstreams.set(
            upstream,
            remote.length
              ? { targets: [...local, ...remote.map((r) => r.server)], weights: [...local.map(() => 1), ...remote.map((r) => r.weight)], remote: true }
              : { targets: local },
          );
        }
      } else if (service.type === "compose" && d.composeService) {
        upstream = `${d.composeService}-${port}`.replace(/[^a-zA-Z0-9-]/g, "-");
        if (!upstreams.has(upstream)) upstreams.set(upstream, { targets: [`${composeAlias(service.slug, d.composeService)}:${port}`] });
      }
    }
    const tunnel = !!d.tunnelId;
    hosts.push({
      hostname: d.hostname,
      upstream,
      redirectTo: d.redirectTo ?? wwwTarget(d.hostname),
      https: d.https && !tunnel,
      forceHttps: d.forceHttps,
      tunnel,
      tls: d.https && !tunnel ? certificateFor(d.hostname, d.certificateId, certs) : null,
    });
  }
  // A copy on another server that does not answer must not hold a visitor for long before the next is tried.
  if ([...upstreams.values()].some((u) => u.remote) && !cfg?.connectTimeout) cfg = { ...(cfg ?? {}), connectTimeout: BALANCE_CONNECT_TIMEOUT } as ServiceProxyConfig;

  return {
    name: `svc-${service.id}`,
    title: `service "${service.name}" (${service.id})`,
    serviceId: service.id,
    stopped,
    upstreams: [...upstreams].map(([key, u]) => ({ key, ...u })),
    hosts,
    options: cfg,
    maintenance: maintenanceOf(service.id, service.maintenance),
    gate: gateOn(cfg) ? { upstream: await gateUpstream(ctx.id) } : null,
    certificates: certificateStamp(
      certs,
      hosts.map((h) => h.tls),
    ),
  };
}

/** The dashboard, served only by the proxy of the machine Serve runs on. */
export async function dashboardModel(): Promise<SiteModel | null> {
  const settings = await getSettings();
  if (!settings.dashboardDomain) return null;
  const certs = settings.rootOrganizationId ? await orgCertificates(settings.rootOrganizationId, LOCAL_SERVER_ID) : [];
  const tunnel = !!(settings as { dashboardTunnelId?: string | null }).dashboardTunnelId;
  const https = settings.dashboardHttps && !tunnel;
  const tls = https ? certificateFor(settings.dashboardDomain, settings.dashboardCertificateId, certs) : null;
  return {
    name: "_dashboard",
    title: "dashboard",
    serviceId: null,
    stopped: false,
    upstreams: [{ key: "dashboard", targets: [env.dashboardUpstream] }],
    hosts: [
      {
        hostname: settings.dashboardDomain,
        upstream: "dashboard",
        redirectTo: null,
        https,
        forceHttps: true,
        tunnel,
        tls,
        allow: settings.dashboardAllowlist,
      },
    ],
    options: null,
    certificates: certificateStamp(certs, [tls]),
  };
}

/** Status pages on their own domains: served like the dashboard, by the proxy of the machine Serve runs on. */
export async function statusModel(): Promise<SiteModel | null> {
  const pages = await statusPageHosts();
  if (!pages.length) return null;
  const certs = (await Promise.all([...new Set(pages.map((p) => p.organizationId))].map((org) => orgCertificates(org, LOCAL_SERVER_ID)))).flat();
  const hosts: HostModel[] = pages.map((p) => ({
    hostname: p.domain,
    upstream: "status",
    redirectTo: null,
    https: p.https && !p.tunnelId,
    forceHttps: true,
    tunnel: !!p.tunnelId,
    tls: p.https && !p.tunnelId ? certificateFor(p.domain, p.certificateId, certs) : null,
  }));
  return {
    name: "_status",
    title: "status pages",
    serviceId: null,
    stopped: false,
    upstreams: [{ key: "status", targets: [env.dashboardUpstream] }],
    hosts,
    options: null,
    certificates: certificateStamp(
      certs,
      hosts.map((h) => h.tls),
    ),
  };
}

/** Status pages with their own domain. */
export async function statusPageHosts() {
  const rows = await db
    .select({
      domain: schema.statusPage.domain,
      https: schema.statusPage.https,
      certificateId: schema.statusPage.certificateId,
      tunnelId: schema.statusPage.tunnelId,
      organizationId: schema.statusPage.organizationId,
    })
    .from(schema.statusPage)
    .where(isNotNull(schema.statusPage.domain));
  return rows.map((r) => ({ ...r, domain: r.domain! })).sort((a, b) => a.domain.localeCompare(b.domain));
}

/**
 * Where a proxy on the machine itself (a system nginx in front) connects from: Docker hands the
 * machine's ports to the proxy from the gateway of its main network. Only the machine has that
 * address, and the proxy's ports then answer on 127.0.0.1 only, so nobody else comes in through it.
 */
export async function machineAddresses(ctx: ServerCtx): Promise<string[]> {
  try {
    const info = (await ctx.docker.getNetwork(ctx.network).inspect()) as { IPAM?: { Config?: { Gateway?: string }[] } };
    return (info.IPAM?.Config ?? [])
      .map((c) => c.Gateway)
      .filter((g): g is string => !!g && /^[0-9a-f:.]+$/i.test(g))
      .map((g) => `${g}/${g.includes(":") ? 128 : 32}`);
  } catch (error) {
    // No network yet: nothing to trust. Any other failure stops the sync, as for the tunnel network.
    if ((error as { statusCode?: number }).statusCode === 404) return [];
    throw error;
  }
}

/** Subnets of the network the proxy shares only with cloudflared (trusted for CF-Connecting-IP). */
export async function trustedSubnets(ctx: ServerCtx): Promise<string[]> {
  try {
    const info = (await ctx.docker.getNetwork(tunnelNetworkName(ctx.network)).inspect()) as { IPAM?: { Config?: { Subnet?: string }[] } };
    return (info.IPAM?.Config ?? []).map((c) => c.Subnet).filter((s): s is string => !!s && /^[0-9a-f:.]+\/\d{1,3}$/i.test(s));
  } catch (error) {
    // No tunnel network: nothing to trust. Any other failure stops the sync rather than writing configs without the trust.
    if ((error as { statusCode?: number }).statusCode === 404) return [];
    throw error;
  }
}
