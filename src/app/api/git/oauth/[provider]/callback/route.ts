import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { logActivity } from "@/server/activity";
import { exchangeCode, redirectUri, verifyOAuthState } from "@/server/git/oauth";
import { oauthBaseUrl } from "@/server/git/public-url";
import { verifyGitToken } from "@/server/git/providers";
import { redirectToGitPage } from "@/server/git/github-routes";
import { getSession } from "@/server/auth";
import { accessFrom, organizationRoles } from "@/server/permissions";

/** GitLab, Gitea/Forgejo and Bitbucket redirect here after the user approves the OAuth app. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/git/oauth/[provider]/callback">) {
  const { provider } = await ctx.params;
  const base = await oauthBaseUrl();
  const params = request.nextUrl.searchParams;
  const state = verifyOAuthState(params.get("state"));
  if (!state) return redirectToGitPage(base.url, { error: "This link has expired. Start the connection again." });

  // The signed-in user must be the member who started the flow, still allowed to manage integrations.
  const session = await getSession();
  if (!session || session.user.id !== state.userId) return redirectToGitPage(base.url, { error: "Sign in with the account that started the connection." });
  const [member] = await db
    .select({ role: schema.member.role, roleId: schema.member.roleId, projectIds: schema.member.projectIds })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, state.organizationId), eq(schema.member.userId, state.userId)));
  if (!member || !accessFrom(member, await organizationRoles(state.organizationId)).permissions.has("integrations.manage"))
    return redirectToGitPage(base.url, { error: "You need permission to manage integrations." });

  const [app] = await db
    .select()
    .from(schema.gitOAuthApp)
    .where(and(eq(schema.gitOAuthApp.id, state.appId), eq(schema.gitOAuthApp.organizationId, state.organizationId)));
  if (!app || app.provider !== provider) return redirectToGitPage(base.url, { error: "The OAuth app no longer exists." });

  const denied = params.get("error_description") ?? params.get("error");
  if (denied) return redirectToGitPage(base.url, { error: `${app.name}: ${denied}` });
  const code = params.get("code");
  if (!code) return redirectToGitPage(base.url, { error: `${app.name} did not return an authorization code.` });

  let tokens;
  let login;
  try {
    tokens = await exchangeCode(app, code, redirectUri(base.url, app.provider));
    login = await verifyGitToken(app.provider, tokens.accessToken, app.baseUrl, { oauth: true, organizationId: app.organizationId });
  } catch (e) {
    return redirectToGitPage(base.url, { error: `Could not connect ${app.name}: ${(e as Error).message}` });
  }

  // One connection per app: reconnecting replaces the tokens.
  const secret = encrypt(JSON.stringify(tokens));
  const [existing] = await db.select({ id: schema.gitCredential.id }).from(schema.gitCredential).where(eq(schema.gitCredential.oauthAppId, app.id));
  if (existing) {
    await db.update(schema.gitCredential).set({ secret, publicInfo: login, name: app.name, baseUrl: app.baseUrl }).where(eq(schema.gitCredential.id, existing.id));
    // New tokens may have the access a commit status was refused for.
    const { clearCommitStatusBlock } = await import("@/server/git/commit-status");
    await clearCommitStatusBlock(existing.id);
  } else {
    await db.insert(schema.gitCredential).values({
      id: newId(),
      organizationId: state.organizationId,
      name: app.name,
      provider: app.provider,
      secret,
      publicInfo: login,
      baseUrl: app.baseUrl,
      oauthAppId: app.id,
    });
  }
  await logActivity({ userId: state.userId, organizationId: state.organizationId, action: "git.oauth.connected", message: `Connected ${app.name} as ${login}` });
  return redirectToGitPage(base.url, { connected: login });
}
