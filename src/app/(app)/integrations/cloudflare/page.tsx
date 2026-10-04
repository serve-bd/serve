import { eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { NoAccess } from "@/components/no-access";
import { db, schema } from "@/server/db";
import { Cloudflare } from "@/server/cloudflare/api";
import { oauthConfig } from "@/server/cloudflare/oauth";
import { CloudflareAccounts } from "./accounts";
import { accountSummaries } from "./summaries";

export const metadata = { title: "Cloudflare" };

export default async function CloudflarePage() {
  const ctx = await requireOrg();
  if (!ctx.can("integrations.manage")) return <NoAccess permission="integrations.manage" />;
  const [summaries, tunnels] = await Promise.all([
    accountSummaries(ctx.org.id),
    db.select({ accountId: schema.cloudflareTunnel.cloudflareAccountId }).from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.organizationId, ctx.org.id)),
  ]);
  // Each account is asked for its domains: the count, and whether Serve can still reach it.
  const accounts = await Promise.all(
    summaries.map(async ({ row, summary }) => {
      const tunnelCount = tunnels.filter((t) => t.accountId === row.id).length;
      try {
        const zones = await (await Cloudflare.forRow(row)).zones();
        return { ...summary, zoneCount: zones.length, tunnelCount };
      } catch (e) {
        return { ...summary, error: (e as Error).message, zoneCount: 0, tunnelCount };
      }
    }),
  );
  return <CloudflareAccounts accounts={accounts} isAdmin={ctx.can("integrations.manage")} oauth={!!oauthConfig()} />;
}
