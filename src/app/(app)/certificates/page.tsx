import { desc, eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { getSettings } from "@/server/settings";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { CertificatesView } from "./certificates-view";

export const metadata = { title: "Certificates" };

export default async function CertificatesPage() {
  const ctx = await requireOrg();
  const [certs, accounts, settings] = await Promise.all([
    db.select().from(schema.certificate).where(eq(schema.certificate.organizationId, ctx.org.id)).orderBy(desc(schema.certificate.createdAt)),
    db.select({ id: schema.cloudflareAccount.id, name: schema.cloudflareAccount.name }).from(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.organizationId, ctx.org.id)),
    getSettings(),
  ]);
  return (
    <>
      <PageHeader title="Certificates" description="TLS certificates for your domains. Let's Encrypt certificates renew automatically 30 days before they expire." />
      <PageBody>
        <CertificatesView
          isAdmin={ctx.isAdmin}
          hasAcme={!!settings.acmeEmail}
          staging={settings.acmeStaging}
          serverIp={settings.serverIp}
          accounts={accounts}
          certificates={certs.map((c) => ({
            id: c.id,
            name: c.name,
            domains: c.domains,
            provider: c.provider,
            status: c.status,
            issuer: c.issuer,
            expiresAt: c.expiresAt?.toISOString() ?? null,
            autoRenew: c.autoRenew,
            lastError: c.lastError,
            createdAt: c.createdAt.toISOString(),
          }))}
        />
      </PageBody>
    </>
  );
}
