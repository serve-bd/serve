import { db, schema } from "@/server/db";
import { and, eq } from "drizzle-orm";
import { gitLoginsFor, listRemoteBranches, normalizeRepoUrl } from "@/server/deploy/git";
import type { RemoteRepo } from "@/server/git/providers";

type Login = typeof schema.gitCredential.$inferSelect;

export type GitAccess = { credentialId: string | null; login: string | null; note: string | null } | { error: string };

/** The repositories a login can see; null when they cannot be listed (SSH keys, a provider error). */
async function loginRepositories(cred: Login): Promise<RemoteRepo[] | null> {
  try {
    if (cred.provider === "ssh") return null;
    if (cred.provider === "github-app") {
      const { listAppRepositories } = await import("@/server/git/github-app");
      return await listAppRepositories(cred);
    }
    const { withCredentialToken } = await import("@/server/git/oauth");
    const { listRepositories } = await import("@/server/git/providers");
    const [app] = cred.oauthAppId ? await db.select().from(schema.gitOAuthApp).where(eq(schema.gitOAuthApp.id, cred.oauthAppId)) : [];
    return await withCredentialToken(cred, (token) =>
      listRepositories(cred.provider, token, cred.baseUrl, { oauth: !!cred.oauthAppId, group: app?.groupPath, organizationId: cred.organizationId }),
    );
  } catch {
    return null;
  }
}

/** "owner/repo" (or "group/sub/repo") of an https clone URL, lowercased; null for SSH. */
export function repoPath(repository: string) {
  const url = normalizeRepoUrl(repository);
  if (!URL.canParse(url) || url.startsWith("ssh://")) return null;
  return new URL(url).pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

const reaches = async (repository: string, credentialId: string | null, organizationId: string) =>
  listRemoteBranches({ type: "git", repository, branch: "main", credentialId }, organizationId).then(
    () => true,
    () => false,
  );

/**
 * The git login a service should use for a repository: each of the organization's logins for its
 * host is tried (the GitHub App first, then the newest) until one has access. Public repositories
 * get a login too when one can see them, so pushes deploy (a login is what holds the webhook).
 * `preferred`: a login's name; only that one is tried.
 */
export async function findGitAccess(organizationId: string, repository: string, preferred?: string | null): Promise<GitAccess> {
  const logins = await gitLoginsFor(organizationId, repository);
  const wanted = repoPath(repository);
  if (preferred) {
    const [named] = await db
      .select()
      .from(schema.gitCredential)
      .where(and(eq(schema.gitCredential.organizationId, organizationId), eq(schema.gitCredential.name, preferred)));
    if (!named) return { error: `No git login is named "${preferred}". See Settings → Git for the names.` };
    if (!logins.some((l) => l.id === named.id)) return { error: `The git login "${preferred}" is for another host than ${repository}.` };
    const repos = await loginRepositories(named);
    if (repos?.some((r) => r.fullName.toLowerCase() === wanted) || (await reaches(repository, named.id, organizationId)))
      return { credentialId: named.id, login: named.name, note: null };
    return { error: `The git login "${preferred}" has no access to ${repository}.` };
  }
  // Listing shows what a login was granted, also for public repositories (ls-remote would pass anyway).
  for (const login of logins) {
    const repos = await loginRepositories(login);
    if (wanted && repos?.some((r) => r.fullName.toLowerCase() === wanted)) return { credentialId: login.id, login: login.name, note: null };
  }
  const isPublic = await reaches(repository, null, organizationId);
  if (!isPublic) {
    // Lists stop after a few hundred repositories, and SSH keys cannot list: try cloning with each.
    for (const login of logins) if (await reaches(repository, login.id, organizationId)) return { credentialId: login.id, login: login.name, note: null };
    const tried = logins.map((l) => l.name);
    return {
      error: tried.length
        ? `None of the git logins can reach ${repository} (tried ${tried.join(", ")}). Check the URL, or add a login with access in Settings → Git.`
        : `Could not reach ${repository}. If it is private, add a git login with access in Settings → Git.`,
    };
  }
  return {
    credentialId: null,
    login: null,
    note: logins.length
      ? `No git login has access to ${repository}: it deploys as a public repository, and pushes do not deploy it.`
      : `${repository} deploys as a public repository. Add a git login with access in Settings → Git to deploy on push.`,
  };
}
