import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";

/** Paths where a provider sign-in creates a session (the OAuth callback, an ID token sign-in). */
export function providerSessionPath(path: string | undefined) {
  return !!path && (path.startsWith("/callback/") || path === "/sign-in/social");
}

/** What of better-auth's endpoint context this needs. */
type CookieContext = {
  path?: string;
  getSignedCookie: (name: string, secret: string) => Promise<string | null | false | undefined>;
  context: { secret: string; authCookies: { sessionToken: { name: string } } };
};

/**
 * The session this browser already had, when a provider sign-in replaces it for the same user
 * (confirming it is you with GitHub on the Account page). Read from the request's cookie, so
 * better-auth's own session lookup for the callback is left alone. Another user's session (a
 * different account signing in here) is not touched.
 */
export async function replacedSession(ctx: CookieContext | null | undefined, userId: string) {
  if (!ctx || !providerSessionPath(ctx.path)) return null;
  const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret).catch(() => null);
  if (!token) return null;
  const [row] = await db
    .select({ id: schema.session.id, userId: schema.session.userId, activeOrganizationId: schema.session.activeOrganizationId })
    .from(schema.session)
    .where(eq(schema.session.token, token));
  return row?.userId === userId ? row : null;
}
