import { asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { pageService } from "@/server/services/access";
import { getSettings } from "@/server/settings";
import { certificateCovers } from "@/server/ssl/match";
import { composeServiceNames, composeServicePorts } from "@/server/deploy/compose";
import { PageBody } from "@/components/shell/page-header";
import { DomainsManager } from "./domains-manager";

export const metadata = { title: "Domains" };

export default async function DomainsPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/domains">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  if (service.type === "database") redirect(`/projects/${projectId}/services/${serviceId}`);
  const [domains, certs, cfAccounts, settings] = await Promise.all([
    db.select().from(schema.domain).where(eq(schema.domain.serviceId, serviceId)).orderBy(asc(schema.domain.createdAt)),
    db.select().from(schema.certificate).where(eq(schema.certificate.organizationId, ctx.org.id)),
    db.select({ id: schema.cloudflareAccount.id }).from(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.organizationId, ctx.org.id)),
    getSettings(),
  ]);
  const content = service.compose?.content ?? "";
  return (
    <PageBody>
      <DomainsManager
        serviceId={service.id}
        type={service.type}
        defaultPort={service.runtime.port}
        composeServices={composeServiceNames(content)}
        composePorts={composeServicePorts(content)}
        hasCloudflare={cfAccounts.length > 0}
        hasAcme={!!settings.acmeEmail}
        serverIp={settings.serverIp}
        canGenerate={!!settings.wildcardDomain || (settings.sslipFallback && !!settings.serverIp)}
        certificates={certs.map((c) => ({ id: c.id, name: c.name, domains: c.domains, status: c.status, provider: c.provider }))}
        domains={domains.map((d) => {
          const cert = d.https
            ? certs.find((c) => c.id === d.certificateId) ?? certs.find((c) => certificateCovers(c.domains, d.hostname))
            : undefined;
          return {
            id: d.id,
            hostname: d.hostname,
            port: d.port,
            composeService: d.composeService,
            https: d.https,
            forceHttps: d.forceHttps,
            redirectTo: d.redirectTo,
            generated: d.generated,
            cloudflare: !!d.cloudflareZoneId,
            managedRecord: !!d.cloudflareRecordId,
            certificate: cert ? { id: cert.id, status: cert.status, provider: cert.provider, error: cert.lastError, expiresAt: cert.expiresAt?.toISOString() ?? null } : null,
          };
        })}
      />
    </PageBody>
  );
}
