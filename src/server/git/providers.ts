import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "@/server/process";
import type { GitProviderType } from "@/server/db/schema";

export type RemoteRepo = {
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
  updatedAt: string | null;
  description: string | null;
};

function apiBase(provider: GitProviderType, baseUrl?: string | null) {
  const base = baseUrl?.replace(/\/$/, "");
  switch (provider) {
    case "github":
      return base ? `${base}/api/v3` : "https://api.github.com";
    case "gitlab":
      return `${base ?? "https://gitlab.com"}/api/v4`;
    case "gitea":
      return `${base ?? "https://gitea.com"}/api/v1`;
    case "bitbucket":
      return "https://api.bitbucket.org/2.0";
    default:
      return "";
  }
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(15000) });
  if (res.status === 401 || res.status === 403) throw new Error("The token was rejected. Check that it is valid and has repository access.");
  if (!res.ok) throw new Error(`Provider returned HTTP ${res.status}`);
  return (await res.json()) as T;
}

function authHeaders(provider: GitProviderType, token: string): Record<string, string> {
  if (provider === "gitlab") return { "PRIVATE-TOKEN": token };
  if (provider === "gitea") return { authorization: `token ${token}` };
  return { authorization: `Bearer ${token}` };
}

/** Validate a token and return the account login. */
export async function verifyGitToken(provider: GitProviderType, token: string, baseUrl?: string | null): Promise<string> {
  const base = apiBase(provider, baseUrl);
  const headers = authHeaders(provider, token);
  if (provider === "github") return (await getJson<{ login: string }>(`${base}/user`, headers)).login;
  if (provider === "gitlab") return (await getJson<{ username: string }>(`${base}/user`, headers)).username;
  if (provider === "gitea") return (await getJson<{ login: string }>(`${base}/user`, headers)).login;
  if (provider === "bitbucket") return (await getJson<{ username?: string; display_name: string }>(`${base}/user`, headers)).display_name;
  throw new Error("Unsupported provider");
}

export async function listRepositories(provider: GitProviderType, token: string, baseUrl?: string | null): Promise<RemoteRepo[]> {
  const base = apiBase(provider, baseUrl);
  const headers = authHeaders(provider, token);
  if (provider === "github") {
    const out: RemoteRepo[] = [];
    for (let page = 1; page <= 5; page++) {
      const repos = await getJson<
        { full_name: string; clone_url: string; default_branch: string; private: boolean; pushed_at: string | null; description: string | null }[]
      >(`${base}/user/repos?per_page=100&sort=pushed&page=${page}&affiliation=owner,collaborator,organization_member`, headers);
      out.push(
        ...repos.map((r) => ({
          fullName: r.full_name,
          cloneUrl: r.clone_url,
          defaultBranch: r.default_branch,
          private: r.private,
          updatedAt: r.pushed_at,
          description: r.description,
        })),
      );
      if (repos.length < 100) break;
    }
    return out;
  }
  if (provider === "gitlab") {
    const repos = await getJson<
      { path_with_namespace: string; http_url_to_repo: string; default_branch: string; visibility: string; last_activity_at: string; description: string | null }[]
    >(`${base}/projects?membership=true&per_page=100&order_by=last_activity_at`, headers);
    return repos.map((r) => ({
      fullName: r.path_with_namespace,
      cloneUrl: r.http_url_to_repo,
      defaultBranch: r.default_branch ?? "main",
      private: r.visibility !== "public",
      updatedAt: r.last_activity_at,
      description: r.description,
    }));
  }
  if (provider === "gitea") {
    const repos = await getJson<
      { full_name: string; clone_url: string; default_branch: string; private: boolean; updated_at: string; description: string }[]
    >(`${base}/user/repos?limit=100`, headers);
    return repos.map((r) => ({
      fullName: r.full_name,
      cloneUrl: r.clone_url,
      defaultBranch: r.default_branch,
      private: r.private,
      updatedAt: r.updated_at,
      description: r.description || null,
    }));
  }
  if (provider === "bitbucket") {
    const res = await getJson<{
      values: { full_name: string; links: { clone: { name: string; href: string }[] }; mainbranch?: { name: string }; is_private: boolean; updated_on: string; description: string }[];
    }>(`${base}/repositories?role=member&pagelen=100&sort=-updated_on`, headers);
    return res.values.map((r) => ({
      fullName: r.full_name,
      cloneUrl: r.links.clone.find((c) => c.name === "https")?.href.replace(/\/\/[^@]+@/, "//") ?? "",
      defaultBranch: r.mainbranch?.name ?? "main",
      private: r.is_private,
      updatedAt: r.updated_on,
      description: r.description || null,
    }));
  }
  return [];
}

/** Generate an ed25519 deploy key pair in OpenSSH format. */
export async function generateSshKey(comment: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "serve-key-"));
  try {
    const file = path.join(dir, "id");
    await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", comment, "-f", file, "-q"]);
    return {
      privateKey: await fs.readFile(file, "utf8"),
      publicKey: (await fs.readFile(`${file}.pub`, "utf8")).trim(),
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
