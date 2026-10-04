import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import type { AccountSummary } from "./accounts";

/** The organization's Cloudflare accounts, with how each is connected and who shares its login. */
export async function accountSummaries(organizationId: string) {
  const [accounts, credentials] = await Promise.all([
    db.select().from(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.organizationId, organizationId)).orderBy(schema.cloudflareAccount.name),
    db
      .select({ id: schema.cloudflareCredential.id, authType: schema.cloudflareCredential.authType })
      .from(schema.cloudflareCredential)
      .where(eq(schema.cloudflareCredential.organizationId, organizationId)),
  ]);
  return accounts.map((row) => ({
    row,
    summary: {
      id: row.id,
      name: row.name,
      cfAccountId: row.cfAccountId,
      oauth: credentials.find((c) => c.id === row.credentialId)?.authType === "oauth",
      // The other accounts on the same login: they renew, break and reconnect together.
      sharedWith: accounts.filter((o) => o.credentialId === row.credentialId && o.id !== row.id).map((o) => o.name),
      error: null,
    } satisfies AccountSummary as AccountSummary,
  }));
}
