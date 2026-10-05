import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { UserError } from "@/server/action";
import { tooManyAttempts } from "@/server/attempts";
import { authFor, type OrgContext, passwordLoginAllowed } from "@/server/auth";
import { db, schema } from "@/server/db";
import { getSetting } from "@/server/settings";
import { activeProviders, displayName } from "@/server/sso/config";
import { DELETE_REAUTH, type ReauthMethods, reauthMethods } from "@/lib/reauth";

/** How long a sign-in counts as recent for deleting, for accounts without a password. */
export const DELETE_FRESH_MS = 15 * 60_000;

export async function methodsFor(userId: string): Promise<ReauthMethods> {
  const [rows, signIn, passwordSignIn] = await Promise.all([
    db.select({ providerId: schema.account.providerId }).from(schema.account).where(eq(schema.account.userId, userId)),
    getSetting("signIn"),
    passwordLoginAllowed(),
  ]);
  return reauthMethods({
    linked: rows.map((r) => r.providerId),
    passwordSignIn,
    activeProviders: activeProviders(signIn).map((id) => ({ id, label: displayName(id, signIn.providers[id]) })),
  });
}

/**
 * Deleting a server, a service or a project with services needs proof it is really this person:
 * the password, typed in the confirmation, or (for accounts that sign in with a provider only) a
 * sign-in in the last few minutes. API tokens are their own proof.
 */
export async function requireDeleteProof(ctx: OrgContext, password: string | null | undefined) {
  if (ctx.sessionId.startsWith("api:")) return;
  const methods = await methodsFor(ctx.user.id);
  if (methods.password) {
    if (!password) throw new UserError("Enter your password to delete.");
    if (tooManyAttempts(`reauth:${ctx.user.id}`, 10, 15 * 60_000)) throw new UserError("Too many tries. Wait 15 minutes and try again.");
    const h = await headers();
    const ok = await authFor(h)
      .api.verifyPassword({ body: { password: password.slice(0, 200) }, headers: h })
      .then((r) => !!r?.status)
      .catch(() => false);
    if (!ok) throw new UserError("That password is not right. Nothing was deleted.");
    return;
  }
  const [session] = await db
    .select({ createdAt: schema.session.createdAt })
    .from(schema.session)
    .where(and(eq(schema.session.id, ctx.sessionId), eq(schema.session.userId, ctx.user.id)));
  if (!session || Date.now() - session.createdAt.getTime() > DELETE_FRESH_MS) throw new UserError(DELETE_REAUTH);
}
