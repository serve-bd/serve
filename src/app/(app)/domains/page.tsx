import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { ArrowUpRight, Cloud, Globe, Lock, LockOpen } from "lucide-react";
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
        service: { id: schema.service.id, name: schema.service.name, status: schema.service.status },
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
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="border-b border-line bg-surface-2 text-[11px] font-semibold text-faint">
                  <tr>
                    <th className="px-5 py-2.5 font-semibold">Domain</th>
                    <th className="px-5 py-2.5 font-semibold">Service</th>
                    <th className="px-5 py-2.5 font-semibold">HTTPS</th>
                    <th className="px-5 py-2.5 font-semibold" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map(({ domain: d, service, project }) => {
                    const cert = d.https ? (certs.find((c) => c.id === d.certificateId) ?? certs.find((c) => certificateCovers(c.domains, d.hostname))) : null;
                    return (
                      <tr key={d.id} className="transition-colors hover:bg-hover/40">
                        <td className="px-5 py-3">
                          <a
                            href={`${d.https ? "https" : "http"}://${d.hostname}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-medium text-fg hover:text-accent"
                          >
                            {d.hostname}
                            <ArrowUpRight className="size-3 text-faint" />
                          </a>
                          <div className="mt-0.5 flex gap-1.5">
                            {d.generated && <Badge>Generated</Badge>}
                            {d.cloudflareZoneId && (
                              <Badge tone="warn">
                                <Cloud /> Cloudflare
                              </Badge>
                            )}
                            {d.redirectTo && <Badge tone="info">Redirect</Badge>}
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <Link href={`/projects/${project.id}/services/${service.id}/domains`} className="inline-flex items-center gap-2 text-fg-2 hover:text-fg">
                            <StatusDot status={service.status} />
                            {service.name}
                            <span className="text-faint">· {project.name}</span>
                          </Link>
                        </td>
                        <td className="px-5 py-3">
                          {!d.https ? (
                            <span className="inline-flex items-center gap-1.5 text-muted">
                              <LockOpen className="size-3.5" /> HTTP
                            </span>
                          ) : cert?.status === "active" ? (
                            <span className="inline-flex items-center gap-1.5 text-ok">
                              <Lock className="size-3.5" /> Secured
                            </span>
                          ) : cert?.status === "failed" ? (
                            <span className="text-bad">Certificate failed</span>
                          ) : (
                            <span className="text-info">Pending</span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-right">
                          <Link href={`/projects/${project.id}/services/${service.id}/domains`} className="text-accent hover:underline">
                            Manage
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        {verification && <VerifiedDomainsCard rows={verified.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() }))} />}
      </PageBody>
    </>
  );
}
