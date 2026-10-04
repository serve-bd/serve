import { and, eq, notExists } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { newId } from "@/server/id";
import type { Cloudflare } from "@/server/cloudflare/api";
import { revokeOauth } from "@/server/cloudflare/oauth";

export type FoundAccount = { id: string; name: string; zones: number };

/**
 * The Cloudflare accounts a login reaches, with how many domains each has. A token that may not list
 * accounts (an OAuth grant, or a token without Account Settings) still shows them on its zones.
 */
export async function reachableAccounts(cf: Cloudflare): Promise<FoundAccount[]> {
  const [zones, listed] = await Promise.all([cf.zones(), cf.accounts().catch(() => [])]);
  const found = new Map<string, FoundAccount>();
  for (const a of listed) found.set(a.id, { id: a.id, name: a.name, zones: 0 });
  for (const z of zones) {
    if (!z.account?.id) continue;
    const a = found.get(z.account.id) ?? { id: z.account.id, name: z.account.name ?? "Cloudflare", zones: 0 };
    a.zones++;
    found.set(a.id, a);
  }
  return [...found.values()];
}

/**
 * Give each Cloudflare account its card, all on this login. An account already connected in the
 * organization moves to this login (its tunnels, domains and certificates stay), so signing in again
 * replaces an old login instead of adding a copy. Logins no account uses any more are removed.
 */
export async function linkAccounts(input: { organizationId: string; credentialId: string; authType: "token" | "oauth"; accounts: FoundAccount[]; name?: string }) {
  const existing = await db
    .select({
      id: schema.cloudflareAccount.id,
      name: schema.cloudflareAccount.name,
      cfAccountId: schema.cloudflareAccount.cfAccountId,
      authType: schema.cloudflareCredential.authType,
    })
    .from(schema.cloudflareAccount)
    .innerJoin(schema.cloudflareCredential, eq(schema.cloudflareAccount.credentialId, schema.cloudflareCredential.id))
    .where(eq(schema.cloudflareAccount.organizationId, input.organizationId));
  const linked: { id: string; name: string; added: boolean }[] = [];
  for (const a of input.accounts) {
    const row = existing.find((r) => r.cfAccountId === a.id);
    // An account on a pasted token keeps it: that token never expires, and Traefik may rely on it.
    if (row && row.authType === "token" && input.authType === "oauth") {
      linked.push({ id: row.id, name: row.name, added: false });
    } else if (row) {
      await db.update(schema.cloudflareAccount).set({ credentialId: input.credentialId }).where(eq(schema.cloudflareAccount.id, row.id));
      linked.push({ id: row.id, name: row.name, added: false });
    } else {
      const id = newId();
      // A name typed in the form only fits a login that reaches one account.
      const name = (input.accounts.length === 1 && input.name?.trim()) || a.name;
      await db.insert(schema.cloudflareAccount).values({ id, organizationId: input.organizationId, name, credentialId: input.credentialId, cfAccountId: a.id });
      linked.push({ id, name, added: true });
    }
  }
  await dropUnusedCredentials(input.organizationId);
  return linked;
}

/** Remove logins no account uses, and give up their Cloudflare access. */
export async function dropUnusedCredentials(organizationId: string) {
  const unused = await db
    .select()
    .from(schema.cloudflareCredential)
    .where(
      and(
        eq(schema.cloudflareCredential.organizationId, organizationId),
        notExists(db.select({ id: schema.cloudflareAccount.id }).from(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.credentialId, schema.cloudflareCredential.id))),
      ),
    );
  for (const c of unused) {
    await db.delete(schema.cloudflareCredential).where(eq(schema.cloudflareCredential.id, c.id));
    await revokeOauth(c);
  }
}
