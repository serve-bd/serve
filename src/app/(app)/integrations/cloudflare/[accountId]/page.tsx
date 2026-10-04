import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { NoAccess } from "@/components/no-access";
import { db, schema } from "@/server/db";
import { oauthConfig } from "@/server/cloudflare/oauth";
import { CloudflareAccount } from "../accounts";
import { accountSummaries } from "../summaries";
import { accountPageData } from "../account-data";

export async function generateMetadata({ params }: PageProps<"/integrations/cloudflare/[accountId]">) {
  const { accountId } = await params;
  const [row] = await db.select({ name: schema.cloudflareAccount.name }).from(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.id, accountId));
  return { title: row ? `${row.name} · Cloudflare` : "Cloudflare" };
}

export default async function CloudflareAccountPage({ params }: PageProps<"/integrations/cloudflare/[accountId]">) {
  const { accountId } = await params;
  const ctx = await requireOrg();
  if (!ctx.can("integrations.manage")) return <NoAccess permission="integrations.manage" />;
  const all = await accountSummaries(ctx.org.id);
  const found = all.find((s) => s.row.id === accountId);
  if (!found) notFound();
  // With one account, the Cloudflare page itself is that account's page.
  if (all.length === 1) redirect("/integrations/cloudflare");
  const data = await accountPageData(ctx.org.id, found.row, found.summary);
  return <CloudflareAccount {...data} isAdmin={ctx.can("integrations.manage")} oauth={!!oauthConfig()} />;
}
