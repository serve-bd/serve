import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { ArrowUpRight, ChevronRight, CornerUpRight, Globe, Lock, LockOpen, Waypoints } from "lucide-react";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { certificateCovers } from "@/server/ssl/match";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { Badge, Card, EmptyState } from "@/components/ui/misc";
import { StatusDot } from "@/components/ui/status";
import { getSetting } from "@/server/settings";
import { VerifiedDomainsCard } from "./verified-domains";

export const metadata = { title: "Domains" };

const COLS = "lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.1fr)_auto]";

const providerName: Record<string, string> = {
  "letsencrypt-http": "Let's Encrypt",
  "letsencrypt-cloudflare": "Let's Encrypt",
  "cloudflare-origin": "Cloudflare Origin",
  custom: "Uploaded",
};

function expiresText(days: number) {
  if (days < 0) return "expired";
  if (days >= 730) return `expires in ${Math.floor(days / 365)} years`;
  return `expires in ${days} day${days === 1 ? "" : "s"}`;
}

function redirectHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Where the proxy sends the traffic: a compose service and port, or a port of the app. */
function target(d: { composeService: string | null; port: number | null; pathPrefix: string }) {
  const to = d.composeService ? `${d.composeService}${d.port ? `:${d.port}` : ""}` : d.port ? `port ${d.port}` : "the app's port";
  return `To ${to}${d.pathPrefix && d.pathPrefix !== "/" ? ` at ${d.pathPrefix}` : ""}`;
}

/** One column of a row on wide screens: a short label with a detail under it. */
function Cell({ icon, label, detail, tone = "text-fg-2" }: { icon: React.ReactNode; label: string; detail: string; tone?: string }) {
  return (
    <div className="hidden min-w-0 flex-col gap-0.5 lg:flex">
      <span className={`inline-flex min-w-0 items-center gap-1.5 text-[13px] ${tone}`}>
        {icon}
        <span className="truncate">{label}</span>
      </span>
      <span className="truncate text-xs text-muted">{detail}</span>
    </div>
  );
}

export default async function DomainsPage() {
  const ctx = await requireOrg();
  const verification = !ctx.isRoot && (await getSetting("domainVerification"));
  const [rows, certs, verified] = await Promise.all([
    db
      .select({
        domain: schema.domain,
        service: { id: schema.service.id, name: schema.service.name, status: schema.service.status, serverId: schema.service.serverId },
        project: { id: schema.project.id, name: schema.project.name },
        serverName: schema.server.name,
      })
      .from(schema.domain)
      .innerJoin(schema.service, eq(schema.domain.serviceId, schema.service.id))
      .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
      .leftJoin(schema.server, eq(schema.service.serverId, schema.server.id))
      .where(eq(schema.project.organizationId, ctx.org.id))
      .orderBy(asc(schema.domain.hostname))
      .then((list) => list.filter((r) => ctx.canAccessProject(r.project.id))),
    db.select().from(schema.certificate).where(eq(schema.certificate.organizationId, ctx.org.id)),
    verification
      ? db
          .select({ id: schema.verifiedDomain.id, name: schema.verifiedDomain.name, method: schema.verifiedDomain.method, createdAt: schema.verifiedDomain.createdAt })
          .from(schema.verifiedDomain)
          .where(eq(schema.verifiedDomain.organizationId, ctx.org.id))
          .orderBy(asc(schema.verifiedDomain.name))
      : Promise.resolve([]),
  ]);

  const manyServers = new Set(rows.map((r) => r.service.serverId)).size > 1;
  return (
    <>
      <PageHeader title="Domains" description="Every domain connected to a service in this organization." />
      <PageBody className="flex flex-col gap-6">
        <Card className="overflow-hidden">
          {rows.length === 0 ? (
            <EmptyState icon={<Globe />} title="No domains yet" description="Open a service and add a domain from its Domains tab." />
          ) : (
            <>
              {/* Column names, on screens wide enough for columns. */}
              <div className={`hidden gap-4 border-b border-line bg-surface-2 px-5 py-2.5 text-[11px] font-semibold text-faint lg:grid ${COLS}`}>
                <span>Domain</span>
                <span>Route</span>
                <span>HTTPS</span>
                <span className="w-4" />
              </div>
              <ul className="divide-y divide-line">
                {rows.map(({ domain: d, service, project, serverName }) => {
                  // Only certificates on the service's own server can be served by its proxy.
                  const here = certs.filter((c) => c.serverId === service.serverId);
                  const cert = d.https ? (here.find((c) => c.id === d.certificateId) ?? here.find((c) => certificateCovers(c.domains, d.hostname))) : null;
                  const manage = `/projects/${project.id}/services/${service.id}/domains`;
                  const days = cert?.expiresAt ? Math.floor((cert.expiresAt.getTime() - Date.now()) / 86_400_000) : null;
                  const tls = d.tunnelId
                    ? { icon: <Lock className="size-3.5" />, label: "Secured", tone: "text-ok", detail: "HTTPS ends at Cloudflare" }
                    : !d.https
                      ? { icon: <LockOpen className="size-3.5" />, label: "HTTP only", tone: "text-muted", detail: "No certificate" }
                      : cert?.status === "active"
                        ? {
                            icon: <Lock className="size-3.5" />,
                            label: "Secured",
                            tone: "text-ok",
                            detail: [providerName[cert.provider] ?? cert.provider, days !== null ? expiresText(days) : null].filter(Boolean).join(" · "),
                          }
                        : cert?.status === "failed"
                          ? { icon: <LockOpen className="size-3.5" />, label: "Certificate failed", tone: "text-bad", detail: "Open the domain to see why" }
                          : { icon: <Lock className="size-3.5" />, label: "Certificate pending", tone: "text-muted", detail: "Being issued" };
                  const route = d.redirectTo
                    ? { icon: <CornerUpRight className="size-3.5" />, label: "Redirect", detail: `To ${redirectHost(d.redirectTo)}` }
                    : d.tunnelId || d.wantsTunnel
                      ? { icon: <Waypoints className="size-3.5 text-[#f38020]" />, label: "Cloudflare Tunnel", detail: target(d) }
                      : { icon: <Globe className="size-3.5" />, label: d.cloudflareZoneId ? "Server IP via Cloudflare" : "Server IP", detail: target(d) };
                  return (
                    <li key={d.id} className={`group relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-hover/40 sm:px-5 lg:grid lg:gap-4 ${COLS}`}>
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                          {/* The whole row opens the service's domains; the arrow opens the site. */}
                          <Link href={manage} className="truncate font-medium text-fg after:absolute after:inset-0">
                            {d.hostname}
                          </Link>
                          <a
                            href={`${d.https || d.tunnelId ? "https" : "http"}://${d.hostname}`}
                            target="_blank"
                            rel="noreferrer"
                            title={`Open ${d.hostname}`}
                            className="relative z-10 -m-1 rounded p-1 text-faint hover:text-fg"
                          >
                            <ArrowUpRight className="size-3.5" />
                          </a>
                          {d.generated && <Badge>Generated</Badge>}
                        </div>
                        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                          <span className="inline-flex min-w-0 items-center gap-1.5">
                            <StatusDot status={service.status} />
                            <span className="truncate">
                              {service.name} <span className="text-faint">in {project.name}</span>
                              {manyServers && serverName && <span className="text-faint"> · {serverName}</span>}
                            </span>
                          </span>
                          <span className={`inline-flex items-center gap-1 lg:hidden ${tls.tone}`}>
                            {tls.icon} {tls.label}
                          </span>
                        </div>
                      </div>
                      <Cell icon={route.icon} label={route.label} detail={route.detail} />
                      <Cell icon={tls.icon} label={tls.label} detail={tls.detail} tone={tls.tone} />
                      <ChevronRight className="size-4 flex-none text-faint transition-colors group-hover:text-fg-2" />
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Card>
        {verification && <VerifiedDomainsCard rows={verified.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() }))} />}
      </PageBody>
    </>
  );
}
