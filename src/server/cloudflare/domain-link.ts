import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";

type DomainRow = typeof schema.domain.$inferSelect;

/**
 * The connected Cloudflare account and zone of a domain. Its saved ones while that account is still
 * connected; otherwise (the account was removed and connected again, or the domain was added
 * before) the connected account whose zones hold the hostname, saved back on the domain. Null when
 * no connected account holds it.
 */
export async function domainCloudflare(domain: DomainRow, organizationId: string): Promise<{ accountId: string; zoneId: string } | null> {
  if (domain.cloudflareAccountId && domain.cloudflareZoneId) {
    const [account] = await db
      .select({ id: schema.cloudflareAccount.id })
      .from(schema.cloudflareAccount)
      .where(and(eq(schema.cloudflareAccount.id, domain.cloudflareAccountId), eq(schema.cloudflareAccount.organizationId, organizationId)));
    if (account) return { accountId: domain.cloudflareAccountId, zoneId: domain.cloudflareZoneId };
  }
  const { cloudflareAccountFor } = await import("@/server/ssl/certificates");
  const accountId = await cloudflareAccountFor([domain.hostname], organizationId);
  if (!accountId) return null;
  const { Cloudflare } = await import("./api");
  const zone = await (await Cloudflare.forAccount(accountId)).zoneFor(domain.hostname).catch(() => null);
  if (!zone) return null;
  await db.update(schema.domain).set({ cloudflareAccountId: accountId, cloudflareZoneId: zone.id }).where(eq(schema.domain.id, domain.id));
  return { accountId, zoneId: zone.id };
}
