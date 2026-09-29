import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getSession, requireOrg } from "@/server/auth";
import { forgetToken, getInstallation, publicBaseUrl, readAppSecret, verifyState, writeAppSecret } from "@/server/git/github-app";
import { authorizeState, redirectToGitPage } from "@/server/git/github-routes";

/** GitHub redirects here after the app is installed or its repository access changes. */
export async function GET(request: NextRequest) {
  const base = await publicBaseUrl();
  const installationId = Number(request.nextUrl.searchParams.get("installation_id"));
  if (!installationId) return redirectToGitPage(base, { error: "GitHub did not return an installation." });

  const state = verifyState(request.nextUrl.searchParams.get("state"));
  let candidates: (typeof schema.gitCredential.$inferSelect)[] = [];
  if (state) {
    const auth = await authorizeState(state);
    if (!auth.ok) return redirectToGitPage(base, { error: auth.error });
    candidates = await db
      .select()
      .from(schema.gitCredential)
      .where(and(eq(schema.gitCredential.id, state.credentialId), eq(schema.gitCredential.organizationId, state.organizationId)));
  } else {
    // Installation changed from GitHub's side: match it to one of this organization's apps.
    if (!(await getSession())) return redirectToGitPage(base, { error: "Sign in to finish the GitHub setup." });
    const ctx = await requireOrg();
    if (!ctx.isAdmin) return redirectToGitPage(base, { error: "You need to be an organization admin." });
    candidates = await db
      .select()
      .from(schema.gitCredential)
      .where(and(eq(schema.gitCredential.organizationId, ctx.org.id), eq(schema.gitCredential.provider, "github-app")));
  }

  for (const cred of candidates) {
    const secret = readAppSecret(cred);
    try {
      const installation = await getInstallation(secret, installationId);
      await writeAppSecret(cred.id, { ...secret, installationId, account: installation.account.login });
      await db
        .update(schema.gitCredential)
        .set({ name: `GitHub · ${installation.account.login}`, publicInfo: installation.account.login })
        .where(eq(schema.gitCredential.id, cred.id));
      forgetToken(cred.id);
      return redirectToGitPage(base, { connected: installation.account.login });
    } catch {
      // not this app's installation
    }
  }
  return redirectToGitPage(base, { error: "That installation does not belong to a GitHub App connected here." });
}
