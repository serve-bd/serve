import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LOCAL_SERVER_ID } from "@/server/db/schema";
import { env } from "@/server/env";
import { getSettings } from "@/server/settings";
import { getServer, type ServerCtx } from "@/server/servers/context";
import { domainDnsStatus } from "@/server/dns";
import { certificateCovers } from "@/server/ssl/match";

export type StepState = "ok" | "warn" | "fail" | "skip";
export type ConnectionStep = {
  id: "dns" | "tunnel" | "proxy" | "upstream" | "https";
  title: string;
  state: StepState;
  summary: string;
  detail?: string;
  /** DNS records to add at the registrar. */
  records?: { type: string; name: string; value: string }[];
  /** A shell command that fixes the problem on the host. */
  command?: string;
  fix?: { action: "dns" | "ingress" | "proxy"; label: string };
  link?: { href: string; label: string };
};
export type ConnectionReport = { domain: string | null; route: "ip" | "tunnel"; checkedAt: string; steps: ConnectionStep[] };

const TIMEOUT_S = 4;

function tunnelTarget(cfTunnelId: string) {
  return `${cfTunnelId}.cfargotunnel.com`;
}

type Tunnel = typeof schema.cloudflareTunnel.$inferSelect;

async function loadTunnel(id: string): Promise<Tunnel | null> {
  const [tunnel] = await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.id, id));
  return tunnel ?? null;
}

async function dnsStep(domain: string, route: "ip" | "tunnel", serverIp: string | null, tunnel: Tunnel | null): Promise<ConnectionStep> {
  const title = "DNS";
  if (route === "tunnel" && tunnel) {
    const target = tunnelTarget(tunnel.cfTunnelId);
    try {
      const { Cloudflare } = await import("@/server/cloudflare/api");
      const cf = await Cloudflare.forAccount(tunnel.cloudflareAccountId);
      const zone = await cf.zoneFor(domain);
      if (!zone) {
        return {
          id: "dns",
          title,
          state: "fail",
          summary: `${domain} is not in a zone of the tunnel's Cloudflare account`,
          detail: "Move the domain's DNS to that Cloudflare account, or pick a domain it manages.",
        };
      }
      const records = (await cf.dnsRecords(zone.id, { name: domain })).filter((r) => ["A", "AAAA", "CNAME"].includes(r.type));
      const cname = records.find((r) => r.type === "CNAME" && r.content === target);
      if (cname?.proxied) return { id: "dns", title, state: "ok", summary: `CNAME points at the tunnel (${zone.name})` };
      const fix = { action: "dns" as const, label: "Fix DNS" };
      if (cname)
        return { id: "dns", title, state: "fail", summary: "The CNAME is not proxied (grey cloud)", detail: "Tunnel records only work when Cloudflare proxies them.", fix };
      if (records.length) {
        return {
          id: "dns",
          title,
          state: "fail",
          summary: `${domain} has a ${records[0].type} record to ${records[0].content}`,
          detail: `It must be a proxied CNAME to ${target}. Fix DNS replaces records Serve created; remove other records in Cloudflare first.`,
          records: [{ type: "CNAME", name: domain, value: target }],
          fix,
        };
      }
      return { id: "dns", title, state: "fail", summary: "No DNS record yet", records: [{ type: "CNAME", name: domain, value: target }], fix };
    } catch (e) {
      return { id: "dns", title, state: "warn", summary: "Could not read DNS from Cloudflare", detail: (e as Error).message };
    }
  }

  const rootOrg = (await getSettings()).rootOrganizationId ?? undefined;
  const { status, records, origin } = await domainDnsStatus(domain, serverIp, { organizationId: rootOrg });
  const want = serverIp ? [{ type: "A", name: domain, value: serverIp }] : undefined;
  switch (status) {
    case "ok":
      return {
        id: "dns",
        title,
        state: "ok",
        summary: origin?.length ? `Proxied by Cloudflare to ${origin.join(", ")}` : records.length ? `Points to ${records.join(", ")}` : "Resolves",
      };
    case "missing":
      return {
        id: "dns",
        title,
        state: "fail",
        summary: "No A record found",
        detail: "Add this record at your DNS provider. Changes can take a few minutes to show.",
        records: want,
      };
    case "proxied":
      return {
        id: "dns",
        title,
        state: "warn",
        summary: "Proxied by Cloudflare (orange cloud)",
        detail: `${records.join(", ")} are Cloudflare addresses, so the real target is hidden. It works when Cloudflare forwards to ${serverIp ?? "this server"} and its SSL mode is Full. Choose Cloudflare Tunnel above for a setup without an open port.`,
      };
    case "wrong":
      return {
        id: "dns",
        title,
        state: "fail",
        summary: origin ? `Cloudflare forwards to ${records.join(", ")}` : `Points to ${records.join(", ")}`,
        detail: `Expected ${serverIp}. Update the A record${origin ? " in Cloudflare" : ""}.`,
        records: want,
      };
    default:
      return {
        id: "dns",
        title,
        state: "warn",
        summary: `Resolves to ${records.join(", ")}`,
        detail: "Set this server's public IP in Settings → General so Serve can compare.",
        link: { href: "/servers/local", label: "Server settings" },
      };
  }
}

async function tunnelStep(domain: string, tunnel: Tunnel): Promise<ConnectionStep> {
  const title = "Cloudflare Tunnel";
  const link = { href: "/integrations/cloudflare", label: "Open tunnels" };
  try {
    const { Cloudflare } = await import("@/server/cloudflare/api");
    const { cfAccountIdOf, refreshTunnelStatus } = await import("@/server/cloudflare/tunnels");
    const status = await refreshTunnelStatus(tunnel);
    if (status !== "healthy") {
      const [fresh] = await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.id, tunnel.id));
      return {
        id: "tunnel",
        title,
        state: status === "degraded" ? "warn" : "fail",
        summary: status === "down" || status === "pending" ? "The connector is not connected" : `Tunnel is ${status}`,
        detail: fresh?.statusMessage ?? "Serve restarts the connector container automatically. Check its logs if this stays red.",
        link,
      };
    }
    const cf = await Cloudflare.forAccount(tunnel.cloudflareAccountId);
    const res = await cf.request<{ config?: { ingress?: { hostname?: string; service: string }[] } }>(
      "GET",
      `/accounts/${await cfAccountIdOf(tunnel.cloudflareAccountId)}/cfd_tunnel/${tunnel.cfTunnelId}/configurations`,
    );
    const rule = res.result.config?.ingress?.find((r) => r.hostname === domain);
    const fix = { action: "ingress" as const, label: "Sync routes" };
    if (!rule) return { id: "tunnel", title, state: "fail", summary: `Connected, but ${domain} is not routed`, detail: "The tunnel has no route for this domain yet.", fix };
    const ctx = await getServer(LOCAL_SERVER_ID);
    const expected = `http://${ctx.proxyContainer}:80`;
    if (rule.service !== expected) return { id: "tunnel", title, state: "fail", summary: `Routes to ${rule.service}`, detail: `Expected ${expected}.`, fix };
    const [fresh] = await db.select({ statusMessage: schema.cloudflareTunnel.statusMessage }).from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.id, tunnel.id));
    return { id: "tunnel", title, state: "ok", summary: fresh?.statusMessage ?? "Connected and routed to the proxy" };
  } catch (e) {
    return { id: "tunnel", title, state: "warn", summary: "Could not read the tunnel from Cloudflare", detail: (e as Error).message, link };
  }
}

async function proxyStep(ctx: ServerCtx): Promise<ConnectionStep & { running: boolean }> {
  const title = "Proxy";
  const link = { href: `/servers/${LOCAL_SERVER_ID}/proxy`, label: "Open proxy" };
  const { proxyStateOf, proxyStatus, listSiteFiles } = await import("@/server/proxy/nginx");
  const { proxyLabels } = await import("@/server/proxy/config");
  const state = await proxyStateOf(ctx.id);
  if (state.kind === "none") {
    return {
      id: "proxy",
      title,
      state: "fail",
      running: false,
      summary: "This server has no proxy",
      detail: "A dashboard domain needs a proxy. Choose nginx, Caddy or Traefik on the Proxy page.",
      link,
    };
  }
  const label = proxyLabels[state.kind];
  const status = await proxyStatus(ctx);
  if (state.stopped || !status.running) {
    return {
      id: "proxy",
      title,
      state: "fail",
      running: false,
      summary: state.stopped ? `${label} is stopped` : `${label} is not running`,
      detail: "Start it on the Proxy page.",
      link,
    };
  }
  const files = await listSiteFiles(ctx).catch(() => []);
  if (!files.some((f) => f.kind === "dashboard")) {
    return { id: "proxy", title, state: "fail", running: true, summary: `${label} has no route for the dashboard`, fix: { action: "proxy", label: "Write route" }, link };
  }
  return { id: "proxy", title, state: "ok", running: true, summary: `${label} is running and routes the domain` };
}

async function upstreamStep(ctx: ServerCtx): Promise<ConnectionStep> {
  const title = "Dashboard reachable from the proxy";
  const upstream = env.dashboardUpstream;
  const [host, port = "80"] = upstream.split(/:(?=\d+$)/);
  const { execInContainer } = await import("@/server/docker/client");
  const res = await Promise.race([
    execInContainer(ctx.proxyContainer, ["wget", "-q", "-T", String(TIMEOUT_S), "-O", "/dev/null", `http://${upstream}/api/health`], {}, ctx.docker).catch((e: Error) => ({
      exitCode: -1,
      output: e.message,
    })),
    new Promise<{ exitCode: number; output: string }>((r) => setTimeout(() => r({ exitCode: -2, output: "timed out" }), (TIMEOUT_S + 3) * 1000)),
  ]);
  if (res.exitCode === 0) return { id: "upstream", title, state: "ok", summary: `The proxy reaches ${upstream}` };
  const out = res.output.trim().split("\n").pop() ?? "";
  const onHost = ["host.docker.internal", "localhost", "127.0.0.1", "gateway.docker.internal"].includes(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host);
  if (/timed out/i.test(out) && onHost) {
    const subnet = await ctx.docker
      .getNetwork(ctx.network)
      .inspect()
      .then((n: { IPAM?: { Config?: { Subnet?: string }[] } }) => n.IPAM?.Config?.[0]?.Subnet ?? null)
      .catch(() => null);
    return {
      id: "upstream",
      title,
      state: "fail",
      summary: `Connection to ${upstream} timed out`,
      detail: "The dashboard runs on the host here, and the host firewall blocks Docker containers from reaching it. Allow the proxy's network on the dashboard port once:",
      command: `sudo ufw allow from ${subnet ?? "<docker network subnet>"} to any port ${port} proto tcp`,
    };
  }
  if (/bad address|resolve/i.test(out)) {
    return {
      id: "upstream",
      title,
      state: "fail",
      summary: `The proxy cannot find ${host}`,
      detail: `The Serve container must be on the "${ctx.network}" Docker network, or set SERVE_DASHBOARD_UPSTREAM to an address the proxy can reach.`,
    };
  }
  if (/refused/i.test(out)) {
    return {
      id: "upstream",
      title,
      state: "fail",
      summary: `${upstream} refused the connection`,
      detail: `Nothing listens on port ${port}, or it listens only on 127.0.0.1. Serve must listen on all interfaces.`,
    };
  }
  if (/not found|exec/i.test(out) && res.exitCode === -1) {
    return { id: "upstream", title, state: "skip", summary: "This proxy image cannot run the test" };
  }
  return { id: "upstream", title, state: "fail", summary: `Could not reach ${upstream}`, detail: out || undefined };
}

async function httpsStep(domain: string, route: "ip" | "tunnel", https: boolean, rootOrg: string | null): Promise<ConnectionStep> {
  const secure = route === "tunnel" || https;
  const url = `${secure ? "https" : "http"}://${domain}/api/health`;
  const title = secure ? "HTTPS" : "HTTP";
  let cert: ConnectionStep | null = null;
  if (route === "ip" && https && rootOrg) {
    // The local proxy serves the dashboard with the Root organization's certificates stored on it.
    const certs = await db
      .select()
      .from(schema.certificate)
      .where(and(eq(schema.certificate.organizationId, rootOrg), eq(schema.certificate.serverId, LOCAL_SERVER_ID)));
    const c = certs.find((x) => certificateCovers(x.domains, domain));
    const link = { href: "/certificates", label: "Certificates" };
    if (!c) cert = { id: "https", title, state: "fail", summary: "No certificate yet", detail: "Save the domain with HTTPS on and set a Let's Encrypt email below.", link };
    else if (c.status === "failed") cert = { id: "https", title, state: "fail", summary: "Certificate request failed", detail: c.lastError ?? undefined, link };
    else if (c.status !== "active")
      cert = { id: "https", title, state: "warn", summary: `Certificate is ${c.status}`, detail: "Let's Encrypt usually takes under a minute.", link };
  }
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8000), cache: "no-store" });
    const ms = Date.now() - started;
    if (res.ok) return { id: "https", title, state: "ok", summary: `${url.replace(/\/api\/health$/, "")} answers in ${ms} ms` };
    if (res.status >= 300 && res.status < 400) {
      return { id: "https", title, state: "warn", summary: `Redirects (${res.status}) to ${res.headers.get("location") ?? "another address"}` };
    }
    const hint =
      res.status === 502 || res.status === 504
        ? "The proxy could not reach the dashboard. See the step above."
        : res.status === 530 || res.status === 1033
          ? "Cloudflare cannot reach the tunnel connector."
          : res.status === 404
            ? "The request reached a server that does not know this domain."
            : undefined;
    return cert ?? { id: "https", title, state: "fail", summary: `${url.replace(/\/api\/health$/, "")} returned HTTP ${res.status}`, detail: hint };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const code = err.cause?.code ?? "";
    const summary =
      err.name === "TimeoutError"
        ? "No answer within 8 seconds"
        : /CERT|SSL|TLS/i.test(code + (err.cause?.message ?? ""))
          ? `TLS error: ${err.cause?.message ?? code}`
          : code === "ENOTFOUND"
            ? "The domain does not resolve yet"
            : code === "ECONNREFUSED"
              ? "Connection refused"
              : `Request failed${code ? ` (${code})` : ""}`;
    return cert ?? { id: "https", title, state: "fail", summary, detail: `Requested ${url}.` };
  }
}

/** Walks the whole path of a dashboard request, from DNS to the Serve process. */
export async function dashboardConnectionReport(): Promise<ConnectionReport> {
  const s = await getSettings();
  const domain = s.dashboardDomain;
  const tunnel = s.dashboardTunnelId ? await loadTunnel(s.dashboardTunnelId) : null;
  // Meant for a tunnel but none is there (removed, or its Cloudflare account was disconnected).
  const waiting = !tunnel && (s.dashboardWantsTunnel || !!s.dashboardTunnelId);
  const route = tunnel ? "tunnel" : "ip";
  const report: ConnectionReport = { domain, route: waiting ? "tunnel" : route, checkedAt: new Date().toISOString(), steps: [] };
  if (!domain) return report;
  const [local] = await db.select({ publicIp: schema.server.publicIp }).from(schema.server).where(eq(schema.server.id, LOCAL_SERVER_ID));
  const ctx = await getServer(LOCAL_SERVER_ID);

  const [dns, tun, proxy] = await Promise.all([
    dnsStep(domain, route, local?.publicIp ?? s.serverIp, tunnel),
    tunnel ? tunnelStep(domain, tunnel) : Promise.resolve(null),
    proxyStep(ctx),
  ]);
  const { running, ...proxyRest } = proxy;
  const upstream: ConnectionStep = running
    ? await upstreamStep(ctx)
    : { id: "upstream", title: "Dashboard reachable from the proxy", state: "skip", summary: "Waiting for the proxy" };
  const https = await httpsStep(domain, route, s.dashboardHttps, s.rootOrganizationId);
  if (waiting) {
    report.steps = [
      {
        id: "tunnel",
        title: "Cloudflare Tunnel",
        state: "fail",
        summary: "Waiting for a tunnel",
        detail:
          "The dashboard domain is set to use a Cloudflare Tunnel, but this server has none. Create one in Integrations → Cloudflare and Serve reconnects the domain automatically, or switch the route to Server IP above.",
      },
      proxyRest,
      upstream,
    ];
    return report;
  }
  report.steps = [dns, ...(tun ? [tun] : []), proxyRest, upstream, https];
  return report;
}

export class DashboardFixError extends Error {}

/** One-click fixes offered by the checklist. */
export async function applyDashboardFix(action: "dns" | "ingress" | "proxy") {
  const s = await getSettings();
  if (!s.dashboardDomain) throw new DashboardFixError("Save a dashboard domain first.");
  if (action === "proxy") {
    const { syncDashboardProxy } = await import("@/server/proxy/nginx");
    await syncDashboardProxy();
    return null;
  }
  const tunnel = s.dashboardTunnelId ? await loadTunnel(s.dashboardTunnelId) : null;
  if (!tunnel) throw new DashboardFixError("The dashboard is not routed through a tunnel.");
  if (action === "ingress") {
    const { syncTunnelIngress } = await import("@/server/cloudflare/tunnels");
    await syncTunnelIngress(tunnel.id).catch((e: Error) => {
      throw new DashboardFixError(e.message);
    });
    return null;
  }
  const { Cloudflare } = await import("@/server/cloudflare/api");
  const cf = await Cloudflare.forAccount(tunnel.cloudflareAccountId);
  const zone = await cf.zoneFor(s.dashboardDomain);
  if (!zone) throw new DashboardFixError(`${s.dashboardDomain} is not in a zone of the tunnel's Cloudflare account.`);
  try {
    await cf.upsertTunnelRecord(zone.id, s.dashboardDomain, tunnel.cfTunnelId);
  } catch (e) {
    throw new DashboardFixError((e as Error).message);
  }
  return null;
}
