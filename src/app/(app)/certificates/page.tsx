import { eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { getSettings } from "@/server/settings";
import { certificatesWithServers } from "@/server/ssl/certificates";
import { serversForOrg } from "@/server/servers/access";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { CertificatesView } from "./certificates-view";

export const metadata = { title: "Certificates" };

export default async function CertificatesPage() {
  const ctx = await requireOrg();
  const [rows, accounts, settings, servers] = await Promise.all([
    certificatesWithServers(ctx.org.id).then((r) => r.reverse()),
    db.select({ id: schema.cloudflareAccount.id, name: schema.cloudflareAccount.name }).from(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.organizationId, ctx.org.id)),
    getSettings(),
    db.select({ id: schema.server.id, publicIp: schema.server.publicIp }).from(schema.server),
  ]);
  const orgServers = await serversForOrg(ctx.org.id);
  const ipOf = new Map(servers.map((s) => [s.id, s.publicIp]));
  const showServers = servers.length > 1;
  return (
    <>
      <PageHeader title="Certificates" description="TLS certificates for your domains. Let's Encrypt certificates renew automatically 30 days before they expire." />
      <PageBody>
        <CertificatesView
          isAdmin={ctx.isAdmin}
          hasAcme={!!settings.acmeEmail}
          staging={settings.acmeStaging}
          serverIp={ipOf.get("local") ?? settings.serverIp}
          servers={orgServers}
          accounts={accounts}
          certificates={rows.map(({ certificate: c, serverName }) => ({
            id: c.id,
            server: showServers ? serverName : null,
            serverIp: ipOf.get(c.serverId) ?? null,
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
