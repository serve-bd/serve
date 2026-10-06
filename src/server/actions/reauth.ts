"use server";

import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { tooManyAttempts } from "@/server/attempts";
import { authFor } from "@/server/auth";
import { db, schema } from "@/server/db";
import { methodsFor } from "@/server/delete-proof";

const SIGNED_OUT = "You were signed out. Sign in again to continue.";

/** The session read from the database, not the minute-long cookie copy. */
async function currentSession(h: Headers) {
  const session = await authFor(h)
    .api.getSession({ headers: h, query: { disableCookieCache: true } })
    .catch(() => null);
  if (!session) throw new UserError(SIGNED_OUT);
  return session;
}

/** How the signed-in user can confirm it is them, and who they are (a provider return resumes only for the same user). */
export async function identityMethods() {
  return act(async () => {
    const session = await currentSession(await headers());
    return { userId: session.user.id, email: session.user.email, ...(await methodsFor(session.user.id)) };
  });
}

/**
 * Checks the password and counts this sign-in as recent again, the way better-auth itself lets a
 * password stand in for a recent sign-in (deleting an account). better-auth measures that from the
 * session's start, so the start moves to now: the same session, device and open organization.
 */
export async function confirmPassword(password: string) {
  return act(async () => {
    const value = z.string().min(1, "Enter your password").max(200).parse(password);
    const h = await headers();
    const session = await currentSession(h);
    const userId = session.user.id;
    if (!(await methodsFor(userId)).password) throw new UserError("This account confirms with its sign-in provider, not a password.");
    if (tooManyAttempts(`reauth:${userId}`, 10, 15 * 60_000)) throw new UserError("Too many tries. Wait 15 minutes and try again.");
    const ok = await authFor(h)
      .api.verifyPassword({ body: { password: value }, headers: h })
      .then((r) => !!r?.status)
      .catch((error: { status?: unknown; statusCode?: number }) => {
        if (error?.statusCode === 401 || error?.status === "UNAUTHORIZED") throw new UserError(SIGNED_OUT);
        return false;
      });
    if (!ok) throw new UserError("That password is not right.");
    await db
      .update(schema.session)
      .set({ createdAt: new Date() })
      .where(and(eq(schema.session.id, session.session.id), eq(schema.session.userId, userId)));
    // Writes the session cookie copy again, so the next request sees the new start right away.
    await authFor(h).api.getSession({ headers: h, query: { disableCookieCache: true } });
    return null;
  });
}
