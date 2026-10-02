import { getSession } from "@/server/auth";
import { memberAccess } from "@/server/permissions";
import type { AppState } from "./github-app";

/** The signed-in user must be the one who started the flow and may still manage integrations. */
export async function authorizeState(state: AppState | null) {
  if (!state) return { error: "This link has expired. Start again from Git providers." };
  const session = await getSession();
  if (!session || session.user.id !== state.userId) return { error: "Sign in with the account that started the GitHub setup." };
  // The same permission that started the flow (startGithubApp, githubAppInstallUrl).
  const access = await memberAccess(state.organizationId, state.userId);
  if (!access?.permissions.has("integrations.manage")) return { error: "Your role cannot manage integrations." };
  return { ok: true as const };
}

export async function redirectToGitPage(base: string, params: Record<string, string>) {
  const url = new URL("/integrations/git", base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return Response.redirect(url, 303);
}
