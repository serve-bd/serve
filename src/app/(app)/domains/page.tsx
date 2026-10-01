import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { ArrowUpRight, ChevronRight, Cloud, Globe, Lock, LockOpen } from "lucide-react";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { certificateCovers } from "@/server/ssl/match";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { Badge, Card, EmptyState } from "@/components/ui/misc";
import { StatusDot } from "@/components/ui/status";
import { getSetting } from "@/server/settings";
import { VerifiedDomainsCard } from "./verified-domains";

export const metadata = { title: "Domains" };

export default async function DomainsPage() {
  const ctx = await requireOrg();
  const verification = !ctx.isRoot && (await getSetting("domainVerification"));
  const [rows, certs, verified] = await Promise.all([
    db
      .select({
        domain: schema.domain,
        service: { id: schema.service.id, name: schema.service.name, status: schema.service.status, serverId: schema.service.serverId },
        project: { id: schema.project.id, name: schema.project.name },
      })
      .from(schema.domain)
      .innerJoin(schema.service, eq(schema.domain.serviceId, schema.service.id))
      .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
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

  return (
    <>
      <PageHeader title="Domains" description="Every domain connected to a service in this organization." />
      <PageBody className="flex flex-col gap-6">
        <Card className="overflow-hidden">
          {rows.length === 0 ? (
            <EmptyState icon={<Globe />} title="No domains yet" description="Open a service and add a domain from its Domains tab." />
          ) : (
            <ul className="divide-y divide-line">
              {rows.map(({ domain: d, service, project }) => {
                // Only certificates on the service's own server can be served by its proxy.
                const here = certs.filter((c) => c.serverId === service.serverId);
                const cert = d.https ? (here.find((c) => c.id === d.certificateId) ?? here.find((c) => certificateCovers(c.domains, d.hostname))) : null;
                const manage = `/projects/${project.id}/services/${service.id}/domains`;
                const tls = d.tunnelId
                  ? { icon: <Lock className="size-3.5" />, label: "Secured by Cloudflare", tone: "text-ok" }
                  : !d.https
                    ? { icon: <LockOpen className="size-3.5" />, label: "HTTP only", tone: "text-muted" }
                    : cert?.status === "active"
                      ? { icon: <Lock className="size-3.5" />, label: "Secured", tone: "text-ok" }
                      : cert?.status === "failed"
                        ? { icon: <LockOpen className="size-3.5" />, label: "Certificate failed", tone: "text-bad" }
                        : { icon: <Lock className="size-3.5" />, label: "Certificate pending", tone: "text-muted" };
                return (
                  <li key={d.id} className="group relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-hover/40 sm:px-5">
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
                        {d.cloudflareZoneId && (
                          <Badge tone="warn">
                            <Cloud /> Cloudflare
                          </Badge>
                        )}
                        {d.redirectTo && <Badge tone="info">Redirect</Badge>}
                      </div>
                      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                          <StatusDot status={service.status} />
                          <span className="truncate">
                            {service.name} <span className="text-faint">in {project.name}</span>
                          </span>
                        </span>
                        <span className={`inline-flex items-center gap-1 sm:hidden ${tls.tone}`}>
                          {tls.icon} {tls.label}
                        </span>
                      </div>
                    </div>
                    <span className={`hidden flex-none items-center gap-1.5 text-[13px] sm:inline-flex ${tls.tone}`}>
                      {tls.icon} {tls.label}
                    </span>
                    <ChevronRight className="size-4 flex-none text-faint transition-colors group-hover:text-fg-2" />
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        {verification && <VerifiedDomainsCard rows={verified.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() }))} />}
      </PageBody>
    </>
  );
}
