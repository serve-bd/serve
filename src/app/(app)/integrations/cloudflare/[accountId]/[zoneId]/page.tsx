import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { decrypt } from "@/server/crypto";
import { Cloudflare } from "@/server/cloudflare/api";
import { getSettings } from "@/server/settings";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { ZoneManager } from "./zone-manager";

export default async function ZonePage(props: PageProps<"/integrations/cloudflare/[accountId]/[zoneId]">) {
  const { accountId, zoneId } = await props.params;
  const ctx = await requireOrg();
  const [account] = await db
    .select()
    .from(schema.cloudflareAccount)
    .where(and(eq(schema.cloudflareAccount.id, accountId), eq(schema.cloudflareAccount.organizationId, ctx.org.id)));
  if (!account) notFound();
  const cf = new Cloudflare(decrypt(account.apiToken));
  const zone = await cf.zone(zoneId).catch(() => null);
  if (!zone) notFound();
  const [records, sslMode, alwaysHttps, settings] = await Promise.all([
    cf.dnsRecords(zoneId),
    cf.sslMode(zoneId).catch(() => null),
    cf.alwaysUseHttps(zoneId).catch(() => null),
    getSettings(),
  ]);
  return (
    <>
      <PageHeader
        title={zone.name}
        description={`Cloudflare zone · ${zone.status}${zone.plan?.name ? ` · ${zone.plan.name}` : ""}`}
        breadcrumbs={[{ label: "Cloudflare", href: "/integrations/cloudflare" }, { label: account.name }, { label: zone.name }]}
      />
      <PageBody>
        <ZoneManager
          accountId={accountId}
          zone={{ id: zone.id, name: zone.name, nameServers: zone.name_servers }}
          records={records.map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied, proxiable: r.proxiable, ttl: r.ttl, comment: r.comment ?? null, priority: r.priority ?? null }))}
          sslMode={sslMode}
          alwaysHttps={alwaysHttps}
          serverIp={settings.serverIp}
          isAdmin={ctx.isAdmin}
        />
      </PageBody>
    </>
  );
}
