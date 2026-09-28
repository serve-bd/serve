import { eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { decrypt } from "@/server/crypto";
import { Cloudflare, type CfZone } from "@/server/cloudflare/api";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { CloudflareAccounts } from "./accounts";

export const metadata = { title: "Cloudflare" };

export default async function CloudflarePage() {
  const ctx = await requireOrg();
  const accounts = await db.select().from(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.organizationId, ctx.org.id));
  const withZones = await Promise.all(
    accounts.map(async (a) => {
      try {
        const zones: CfZone[] = await new Cloudflare(decrypt(a.apiToken)).zones();
        return { id: a.id, name: a.name, zones: zones.map((z) => ({ id: z.id, name: z.name, status: z.status, plan: z.plan?.name ?? null })), error: null as string | null };
      } catch (e) {
        return { id: a.id, name: a.name, zones: [], error: (e as Error).message };
      }
    }),
  );
  return (
    <>
      <PageHeader title="Cloudflare" description="Manage DNS records, SSL modes and certificates for your Cloudflare zones without leaving Serve." />
      <PageBody>
        <CloudflareAccounts accounts={withZones} isAdmin={ctx.isAdmin} />
      </PageBody>
    </>
  );
}
