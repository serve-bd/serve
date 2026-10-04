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
  let zones;
  let accounts;
  try {
    tokens = await exchangeCode(code, state.verifier);
    const cf = new Cloudflare(tokens.access_token);
    [zones, accounts] = await Promise.all([cf.zones(), cf.accounts().catch(() => [])]);
  } catch (e) {
    return back(base, { error: `Could not connect Cloudflare: ${(e as Error).message}` });
  }
  if (!zones.length) return back(base, { error: "The Cloudflare account you picked has no domains. Pick an account with your domains." });
  const granted = [...new Set([...accounts.map((a) => a.id), ...zones.flatMap((z) => (z.account?.id ? [z.account.id] : []))])];
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name ?? zones.find((z) => z.account?.id === id)?.account?.name;

  const existing = await db
    .select()
    .from(schema.cloudflareAccount)
    .where(and(eq(schema.cloudflareAccount.organizationId, state.organizationId), eq(schema.cloudflareAccount.authType, "oauth")));
  let row = state.accountId ? existing.find((a) => a.id === state.accountId) : undefined;
  if (state.accountId) {
    if (!row) return back(base, { error: "That Cloudflare account was disconnected. Connect it again." });
    // Its tunnels live in one Cloudflare account: a sign-in to another account would break them.
    if (row.cfAccountId && !granted.includes(row.cfAccountId))
      return back(base, { error: `You allowed a different Cloudflare account. Sign in again and pick the account of ${row.name}.` });
  } else {
    // Signing in again to an account that is already here renews it instead of adding a copy.
    row = existing.find((a) => a.cfAccountId && granted.includes(a.cfAccountId));
  }

  const columns = { ...tokenColumns(tokens), authType: "oauth" as const };
  if (row) {
    await db.update(schema.cloudflareAccount).set(columns).where(eq(schema.cloudflareAccount.id, row.id));
    await logActivity({ userId: state.userId, organizationId: state.organizationId, action: "cloudflare.connected", message: `Renewed Cloudflare access for ${row.name}` });
    return back(base, { connected: row.name });
  }
  const cfAccountId = granted[0] ?? null;
  const name = (cfAccountId && nameOf(cfAccountId)) || "Cloudflare";
  await db.insert(schema.cloudflareAccount).values({ id: newId(), organizationId: state.organizationId, name, cfAccountId, ...columns });
  await logActivity({
    userId: state.userId,
    organizationId: state.organizationId,
    action: "cloudflare.connected",
    message: `Connected Cloudflare ${name} (${zones.length} zones)`,
  });
  return back(base, { connected: name });
}
