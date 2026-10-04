import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import type { PullRequest } from "@/server/services/previews";
import { apiBase, authHeaders } from "./providers";
import { gitHttp } from "./http";
import { withCredentialToken } from "./oauth";
import { repoPath } from "./repo-webhooks";

type Service = typeof schema.service.$inferSelect;
type Credential = typeof schema.gitCredential.$inferSelect;

/** An open pull request, as its provider lists it. Pull requests from forks are listed but never deployed. */
export type OpenPullRequest = PullRequest & { fork: boolean; url: string | null; updatedAt: string | null };

type Provider = "github" | "gitlab" | "gitea" | "bitbucket";

/** The provider, API base and headers to read the repository's pull requests with. */
async function apiAccess(service: Service, cred: Credential | null): Promise<{ provider: Provider; api: string; call: <T>(url: string) => Promise<T> }> {
  if (service.source?.type !== "git") throw new Error("This app is not built from a repository.");
  const organizationId = cred?.organizationId ?? null;
  const target = { selfHosted: !!cred?.baseUrl?.trim(), organizationId };
  const get = async <T>(url: string, headers: Record<string, string>) => {
    const res = await gitHttp(url, { headers: { accept: "application/json", ...headers } }, target);
    if (res.status === 401 || res.status === 403) throw new Error("The git connection cannot read this repository's pull requests. Check its access.");
    if (res.status === 404) throw new Error("The repository was not found. Check its address and the git connection's access.");
    if (!res.ok) throw new Error(`The git provider answered HTTP ${res.status}.`);
    return JSON.parse(res.text) as T;
  };
  if (!cred) {
    // Public repositories on the two big hosts answer without a token.
    const host = (() => {
      try {
        return new URL(service.source.repository).host.toLowerCase();
      } catch {
        return "";
      }
    })();
    if (host === "github.com") return { provider: "github", api: apiBase("github"), call: (url) => get(url, {}) };
    if (host === "gitlab.com") return { provider: "gitlab", api: apiBase("gitlab"), call: (url) => get(url, {}) };
    throw new Error("Connect this repository with a git connection to list its pull requests.");
  }
  if (cred.provider === "github-app") {
    const { installationToken } = await import("./github-app");
    return { provider: "github", api: apiBase("github", cred.baseUrl), call: async (url) => get(url, { authorization: `Bearer ${await installationToken(cred)}` }) };
  }
  if (cred.provider === "ssh") throw new Error("A deploy key cannot list pull requests. Connect the repository with a token or an app.");
  const provider = cred.provider;
  return {
    provider,
    api: apiBase(provider, cred.baseUrl),
    call: (url) => withCredentialToken(cred, (token) => get(url, authHeaders(provider, token, { oauth: !!cred.oauthAppId }))),
  };
}

/** The open pull requests of an app's repository, newest first, read from its git provider. */
export async function openPullRequests(service: Service): Promise<OpenPullRequest[]> {
  if (service.source?.type !== "git") return [];
  const source = service.source;
  const [cred] = source.credentialId ? await db.select().from(schema.gitCredential).where(eq(schema.gitCredential.id, source.credentialId)) : [null];
  const { provider, api, call } = await apiAccess(service, cred ?? null);
  const path = repoPath(source.repository, cred?.baseUrl);

  if (provider === "github" || provider === "gitea") {
    type Pr = {
      number: number;
      title: string;
      html_url?: string;
      updated_at?: string;
      user?: { login?: string };
      head: { ref: string; sha: string; repo?: { clone_url?: string; full_name?: string } | null };
      base: { ref: string; repo?: { full_name?: string } | null };
    };
    const list = await call<Pr[]>(provider === "github" ? `${api}/repos/${path}/pulls?state=open&per_page=100` : `${api}/repos/${path}/pulls?state=open&limit=50`);
    return list.map((pr) => ({
      number: pr.number,
      branch: pr.head.ref,
      repository: pr.head.repo?.clone_url ?? "",
      title: pr.title,
      sha: pr.head.sha,
      author: pr.user?.login ?? null,
      fullName: pr.base.repo?.full_name ?? path,
      // A deleted fork has no repository left: treated as a fork.
      fork: !pr.head.repo?.full_name || pr.head.repo.full_name !== pr.base.repo?.full_name,
      url: pr.html_url ?? null,
      updatedAt: pr.updated_at ?? null,
    }));
  }
  if (provider === "gitlab") {
    type Mr = {
      iid: number;
      title: string;
      web_url?: string;
      updated_at?: string;
      source_branch: string;
      sha: string;
      author?: { username?: string };
      source_project_id: number;
      target_project_id: number;
    };
    const list = await call<Mr[]>(`${api}/projects/${encodeURIComponent(path)}/merge_requests?state=opened&per_page=100&order_by=updated_at`);
    return list.map((mr) => ({
      number: mr.iid,
      branch: mr.source_branch,
      repository: source.repository,
      title: mr.title,
      sha: mr.sha,
      author: mr.author?.username ?? null,
      fork: mr.source_project_id !== mr.target_project_id,
      url: mr.web_url ?? null,
      updatedAt: mr.updated_at ?? null,
    }));
  }
  type Bb = {
    id: number;
    title: string;
    updated_on?: string;
    links?: { html?: { href?: string } };
    author?: { nickname?: string; display_name?: string };
    source: { branch: { name: string }; commit?: { hash?: string }; repository?: { full_name?: string } };
    destination?: { repository?: { full_name?: string } };
  };
  const res = await call<{ values: Bb[] }>(`${api}/repositories/${path}/pullrequests?state=OPEN&pagelen=50`);
  return res.values.map((pr) => {
    const from = pr.source.repository?.full_name;
    return {
      number: pr.id,
      branch: pr.source.branch.name,
      repository: from ? `https://bitbucket.org/${from}.git` : source.repository,
      title: pr.title,
      // Bitbucket lists short hashes: the clone finds the full one.
      sha: null,
      author: pr.author?.nickname ?? pr.author?.display_name ?? null,
      fullName: pr.destination?.repository?.full_name ?? path,
      fork: !!from && !!pr.destination?.repository?.full_name && from !== pr.destination.repository.full_name,
      url: pr.links?.html?.href ?? null,
      updatedAt: pr.updated_on ?? null,
    };
  });
}
