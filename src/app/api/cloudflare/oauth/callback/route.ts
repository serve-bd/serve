import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { newId } from "@/server/id";
import { logActivity } from "@/server/activity";
import { getSession } from "@/server/auth";
import { accessFrom, organizationRoles } from "@/server/permissions";
import { publicBaseUrl } from "@/server/git/github-app";
import { Cloudflare } from "@/server/cloudflare/api";
import { exchangeCode, readOauthState, tokenColumns } from "@/server/cloudflare/oauth";
import { linkAccounts, reachableAccounts } from "@/server/cloudflare/credentials";

function back(base: string, params: Record<string, string>) {
  const url = new URL("/integrations/cloudflare", base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return Response.redirect(url, 303);
}

/** Cloudflare (through the serve.bd relay page) sends the browser here after "Connect with Cloudflare". */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const state = readOauthState(params.get("state"));
  if (!state) return back(await publicBaseUrl(), { error: "This sign-in has expired. Start it again." });
  // The address the sign-in started from (inside the encrypted state), where the browser is signed in.
  const base = new URL(state.callback).origin;

  // Only the member who started it, still allowed to manage integrations. A link with someone
  // else's code and state cannot connect their Cloudflare account to this one.
  const session = await getSession();
  if (!session || session.user.id !== state.userId) return back(base, { error: "Sign in with the account that started the connection." });
  const [member] = await db
    .select({ role: schema.member.role, roleId: schema.member.roleId, projectIds: schema.member.projectIds })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, state.organizationId), eq(schema.member.userId, state.userId)));
  if (!member || !accessFrom(member, await organizationRoles(state.organizationId)).permissions.has("integrations.manage"))
    return back(base, { error: "You need permission to manage integrations." });

  const denied = params.get("error");
  if (denied === "access_denied") return back(base, { error: "Cloudflare access was not allowed." });
  if (denied) return back(base, { error: `Cloudflare: ${params.get("error_description") ?? denied}` });
  const code = params.get("code");
  if (!code) return back(base, { error: "Cloudflare did not return a sign-in code." });

  let tokens;
  let found;
  try {
    tokens = await exchangeCode(code, state.verifier);
    found = await reachableAccounts(new Cloudflare(tokens.access_token));
  } catch (e) {
    return back(base, { error: `Could not connect Cloudflare: ${(e as Error).message}` });
  }
  if (!found.some((a) => a.zones > 0)) return back(base, { error: "The Cloudflare account you picked has no domains. Pick an account with your domains." });

  if (state.accountId) {
    // Reconnect: the login of that card gets the new access, so every card on it works again.
    const [row] = await db
      .select({ name: schema.cloudflareAccount.name, cfAccountId: schema.cloudflareAccount.cfAccountId, credentialId: schema.cloudflareAccount.credentialId })
      .from(schema.cloudflareAccount)
      .where(and(eq(schema.cloudflareAccount.id, state.accountId), eq(schema.cloudflareAccount.organizationId, state.organizationId)));
    if (!row) return back(base, { error: "That Cloudflare account was disconnected. Connect it again." });
    // Its tunnels live in one Cloudflare account: a sign-in to another account would break them.
    if (row.cfAccountId && !found.some((a) => a.id === row.cfAccountId))
      return back(base, { error: `You allowed a different Cloudflare account. Sign in again and pick the account of ${row.name}.` });
    await db.update(schema.cloudflareCredential).set(tokenColumns(tokens)).where(eq(schema.cloudflareCredential.id, row.credentialId));
    // Accounts newly allowed in this sign-in get their own card on the same login.
    await linkAccounts({ organizationId: state.organizationId, credentialId: row.credentialId, authType: "oauth", accounts: found });
    await logActivity({ userId: state.userId, organizationId: state.organizationId, action: "cloudflare.connected", message: `Renewed Cloudflare access for ${row.name}` });
    return back(base, { connected: row.name });
  }

  const credentialId = newId();
  await db.insert(schema.cloudflareCredential).values({ id: credentialId, organizationId: state.organizationId, authType: "oauth", ...tokenColumns(tokens) });
  // One card per Cloudflare account allowed. Accounts already here move to this sign-in.
  const linked = await linkAccounts({ organizationId: state.organizationId, credentialId, authType: "oauth", accounts: found });
  const names = linked.map((a) => a.name).join(", ");
  await logActivity({ userId: state.userId, organizationId: state.organizationId, action: "cloudflare.connected", message: `Connected Cloudflare ${names} by signing in` });
  return back(base, { connected: names });
}
