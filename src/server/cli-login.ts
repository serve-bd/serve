import crypto from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decryptOrNull, encrypt, randomSecret, sha256 } from "@/server/crypto";
import { newId } from "@/server/id";
import { CLI_LOGIN_TTL, cleanClientName, cliLoginState, newUserCode } from "@/lib/cli-login";

/** Starts a sign-in: the secret the CLI polls with and the code a person approves. */
export async function startCliLogin(input: { client: unknown; version: unknown; ip: string | null }) {
  // Sign-ins nobody finished are dropped after a day.
  await db
    .delete(schema.cliLogin)
    .where(lt(schema.cliLogin.expiresAt, new Date(Date.now() - 86_400_000)))
    .catch(() => {});
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
