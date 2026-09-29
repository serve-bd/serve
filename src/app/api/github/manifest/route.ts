import type { NextRequest } from "next/server";
import { db, schema } from "@/server/db";
import { encrypt } from "@/server/crypto";
import { convertManifest, publicBaseUrl, signState, verifyState, type GithubAppSecret } from "@/server/git/github-app";
import { authorizeState, redirectToGitPage } from "@/server/git/github-routes";
import { logActivity } from "@/server/activity";

/** GitHub redirects here after the app is created from the manifest. */
export async function GET(request: NextRequest) {
  const base = await publicBaseUrl();
  const code = request.nextUrl.searchParams.get("code");
  const state = verifyState(request.nextUrl.searchParams.get("state"));
  const auth = await authorizeState(state);
  if (!auth.ok || !state) return redirectToGitPage(base, { error: auth.error ?? "Invalid request" });
  if (!code) return redirectToGitPage(base, { error: "GitHub did not return an app code." });

  let app;
  try {
    app = await convertManifest(code);
  } catch (e) {
    return redirectToGitPage(base, { error: (e as Error).message });
  }
  const secret: GithubAppSecret = {
    appId: app.id,
    slug: app.slug,
    htmlUrl: app.html_url,
    pem: app.pem,
    webhookSecret: app.webhook_secret,
    clientId: app.client_id,
    clientSecret: app.client_secret,
    installationId: null,
    account: app.owner?.login ?? null,
  };
  await db
    .insert(schema.gitCredential)
    .values({
      id: state.credentialId,
      organizationId: state.organizationId,
      name: `GitHub App · ${app.owner?.login ?? app.slug}`,
      provider: "github-app",
      secret: encrypt(JSON.stringify(secret)),
      publicInfo: app.slug,
    })
    .onConflictDoNothing();
  await logActivity({ userId: state.userId, organizationId: state.organizationId, action: "github.app.created", message: `Created GitHub App ${app.slug}` });

  // Continue straight to installing the app on repositories.
  const next = signState({ credentialId: state.credentialId, organizationId: state.organizationId, userId: state.userId });
  return Response.redirect(`${app.html_url}/installations/new?state=${encodeURIComponent(next)}`, 303);
}
