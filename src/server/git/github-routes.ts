import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getSession } from "@/server/auth";
import type { AppState } from "./github-app";

/** The signed-in user must be the one who started the flow and still be an org admin. */
export async function authorizeState(state: AppState | null) {
  if (!state) return { error: "This link has expired. Start again from Git providers." };
  const session = await getSession();
  if (!session || session.user.id !== state.userId) return { error: "Sign in with the account that started the GitHub setup." };
  const [member] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, state.organizationId), eq(schema.member.userId, state.userId)));
  if (!member || (member.role !== "owner" && member.role !== "admin")) return { error: "You need to be an organization admin." };
  return { ok: true as const };
}

export async function redirectToGitPage(base: string, params: Record<string, string>) {
  const { getSetting } = await import("@/server/settings");
  // During the setup guide, return to its Git step instead.
  const url = new URL((await getSetting("onboardingDone")) ? "/integrations/git" : "/onboarding?step=git", base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return Response.redirect(url, 303);
}
