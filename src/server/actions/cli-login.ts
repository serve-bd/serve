"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requireUser } from "@/server/auth";
import { db, schema } from "@/server/db";
import { newId } from "@/server/id";
import { logActivity } from "@/server/activity";
import { memberAccess } from "@/server/permissions";
import { normalizeGrants } from "@/lib/api-scopes";
import { normalizeUserCode } from "@/lib/cli-login";
import { takeRequest } from "@/server/api/rate-limit";
import { approveCliLogin, denyCliLogin, pendingCliLogin } from "@/server/cli-login";

/** The sign-in behind a code, while it still waits for an answer. */
async function waiting(code: string) {
  const userCode = normalizeUserCode(code);
  const row = userCode ? await pendingCliLogin(userCode) : null;
  if (!row) throw new UserError("No sign-in has this code. Check the code in your terminal.");
  if (row.state === "expired") throw new UserError("This code has expired. Run serve login again.");
  if (row.state !== "pending") throw new UserError("This sign-in was already answered.");
  return row;
}

/**
 * Approves a CLI sign-in for one of your organizations: makes an API token named after the
 * computer, with what your role there allows (everything for owners and admins).
 */
export async function approveCliSignIn(input: { code: string; organizationId: string }) {
  return act(async () => {
    const user = await requireUser();
    // Guessing codes from a signed-in account is slowed down.
    if (!takeRequest(`cli-approve:${user.id}`, 20).allowed) throw new UserError("Too many attempts. Wait a minute and try again.");
    const data = z.object({ code: z.string().max(20), organizationId: z.string().min(1) }).parse(input);
    const row = await waiting(data.code);
    const access = await memberAccess(data.organizationId, user.id);
    if (!access) throw new UserError("You are not a member of that organization.");
    const admin = access.roleId === "owner" || access.roleId === "admin";
    const scopes = admin ? normalizeGrants(["admin"]) : normalizeGrants([...access.permissions]);
    if (!scopes.length) throw new UserError("Your role in that organization allows nothing a token can do.");
    const { randomSecret, sha256 } = await import("@/server/crypto");
    const token = `srv_${randomSecret(30)}`;
    const id = newId();
    const name = `CLI on ${row.client}`.slice(0, 60);
    await db.insert(schema.apiToken).values({
      id,
      organizationId: data.organizationId,
      userId: user.id,
      name,
      tokenHash: sha256(token),
      prefix: token.slice(0, 10),
      scopes,
      projectIds: access.projectIds,
      expiresAt: null,
    });
    if (!(await approveCliLogin(row.id, user.id, data.organizationId, token))) {
      await db.delete(schema.apiToken).where(and(eq(schema.apiToken.id, id), eq(schema.apiToken.userId, user.id)));
      throw new UserError("This sign-in was already answered.");
    }
    await logActivity({ userId: user.id, organizationId: data.organizationId, action: "token.created", message: `Signed in the CLI on ${row.client} (API token "${name}")` });
    return null;
  });
}

export async function denyCliSignIn(code: string) {
  return act(async () => {
    await requireUser();
    const row = await waiting(z.string().max(20).parse(code));
    await denyCliLogin(row.id);
    return null;
  });
}
