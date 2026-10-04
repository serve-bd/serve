import crypto from "node:crypto";
import { and, count, eq, gt, inArray, isNotNull, lt } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decryptOrNull, encrypt, randomSecret, sha256 } from "@/server/crypto";
import { newId } from "@/server/id";
import { takeRequest } from "@/server/api/rate-limit";
import { CLI_CODE_LOOKUPS_PER_MINUTE, CLI_LOGIN_MAX_PENDING, CLI_LOGIN_TTL, cleanClientName, cliLoginState, newUserCode } from "@/lib/cli-login";

/** Whether this person may look up another code now: guessing codes is slowed down. */
export function takeCodeLookup(userId: string) {
  return takeRequest(`cli-code:${userId}`, CLI_CODE_LOOKUPS_PER_MINUTE).allowed;
}

/**
 * Tidies sign-ins: an approved one nobody collected loses its token (made to expire soon anyway),
 * and every sign-in goes a day after it expired. The worker runs it every minute, and each start.
 */
export async function pruneCliLogins() {
  const now = new Date();
  const uncollected = await db
    .select({ id: schema.cliLogin.id, token: schema.cliLogin.token })
    .from(schema.cliLogin)
    .where(and(eq(schema.cliLogin.status, "approved"), lt(schema.cliLogin.expiresAt, now), isNotNull(schema.cliLogin.token)));
  if (uncollected.length) {
    const hashes = uncollected.flatMap((r) => {
      const token = decryptOrNull(r.token);
      return token ? [sha256(token)] : [];
    });
    // Only a token still waiting to be collected has an expiry; one the CLI took is left alone.
    if (hashes.length) await db.delete(schema.apiToken).where(and(inArray(schema.apiToken.tokenHash, hashes), isNotNull(schema.apiToken.expiresAt)));
    await db
      .update(schema.cliLogin)
      .set({ token: null })
      .where(
        inArray(
          schema.cliLogin.id,
          uncollected.map((r) => r.id),
        ),
      );
  }
  await db.delete(schema.cliLogin).where(lt(schema.cliLogin.expiresAt, new Date(now.getTime() - 86_400_000)));
}

/**
 * Starts a sign-in: the secret the CLI polls with and the code a person approves. Null when too
 * many sign-ins wait already.
 */
export async function startCliLogin(input: { client: unknown; version: unknown; ip: string | null }) {
  await pruneCliLogins().catch(() => {});
  const [waiting] = await db
    .select({ n: count() })
    .from(schema.cliLogin)
    .where(and(eq(schema.cliLogin.status, "pending"), gt(schema.cliLogin.expiresAt, new Date())));
  if ((waiting?.n ?? 0) >= CLI_LOGIN_MAX_PENDING) return null;
  const deviceCode = randomSecret(32);
  for (let attempt = 0; ; attempt++) {
    const userCode = newUserCode((n) => crypto.randomInt(n));
    try {
      await db.insert(schema.cliLogin).values({
        id: newId(),
        deviceCodeHash: sha256(deviceCode),
        userCode,
        client: cleanClientName(input.client),
        version: typeof input.version === "string" ? input.version.slice(0, 40) : null,
        ip: input.ip,
        expiresAt: new Date(Date.now() + CLI_LOGIN_TTL * 1000),
      });
      return { deviceCode, userCode };
    } catch (e) {
      // The same short code is still on record: draw another.
      if (attempt >= 5) throw e;
    }
  }
}

export type CliPoll =
  | { status: "pending" | "denied" | "expired" }
  | { status: "approved"; token: string; user: { name: string; email: string }; organization: { id: string; name: string } };

/** What the CLI gets for its device code. An approved token is handed out once; the row is then spent. */
export async function pollCliLogin(deviceCode: string): Promise<CliPoll | null> {
  const [row] = await db
    .select()
    .from(schema.cliLogin)
    .where(eq(schema.cliLogin.deviceCodeHash, sha256(deviceCode)));
  if (!row) return null;
  const state = cliLoginState(row);
  // A used code answers like an unknown one, so polling tells nothing about codes.
  if (state === "spent") return null;
  if (state === "denied") {
    // Said once; the sign-in is then gone.
    await db.delete(schema.cliLogin).where(eq(schema.cliLogin.id, row.id));
    return { status: "denied" };
  }
  if (state !== "approved") return { status: state };
  // Only one poll can take the token, even when two arrive at once.
  const [taken] = await db
    .update(schema.cliLogin)
    .set({ status: "spent", token: null })
    .where(and(eq(schema.cliLogin.id, row.id), eq(schema.cliLogin.status, "approved")))
    .returning({ id: schema.cliLogin.id });
  const token = decryptOrNull(row.token);
  if (!taken || !token || !row.userId || !row.organizationId) return null;
  const [[user], [org]] = await Promise.all([
    db.select({ name: schema.user.name, email: schema.user.email }).from(schema.user).where(eq(schema.user.id, row.userId)),
    db.select({ id: schema.organization.id, name: schema.organization.name }).from(schema.organization).where(eq(schema.organization.id, row.organizationId)),
  ]);
  if (!user || !org) return null;
  // Collected: the token now lasts until someone revokes it.
  await db
    .update(schema.apiToken)
    .set({ expiresAt: null })
    .where(eq(schema.apiToken.tokenHash, sha256(token)));
  return { status: "approved", token, user, organization: org };
}

/** A pending sign-in by its short code, for the approval page. */
export async function pendingCliLogin(userCode: string) {
  const [row] = await db.select().from(schema.cliLogin).where(eq(schema.cliLogin.userCode, userCode));
  if (!row) return null;
  return { ...row, state: cliLoginState(row) };
}

/** Stores the approval with its new token (encrypted until the CLI collects it). */
export async function approveCliLogin(id: string, userId: string, organizationId: string, token: string) {
  const [row] = await db
    .update(schema.cliLogin)
    .set({ status: "approved", userId, organizationId, token: encrypt(token) })
    .where(and(eq(schema.cliLogin.id, id), eq(schema.cliLogin.status, "pending")))
    .returning({ id: schema.cliLogin.id });
  return !!row;
}

export async function denyCliLogin(id: string) {
  await db
    .update(schema.cliLogin)
    .set({ status: "denied", token: null })
    .where(and(eq(schema.cliLogin.id, id), eq(schema.cliLogin.status, "pending")));
}
