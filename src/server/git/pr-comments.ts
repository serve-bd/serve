import type { schema } from "@/server/db";
import { statusProvider, type StatusProvider } from "./commit-status";
import { gitHttp } from "./http";
import { apiBase, authHeaders } from "./providers";
import { repoPath } from "./repo-webhooks";
import { hmac } from "@/server/crypto";

/**
 * The preview comment on a pull request (GitHub, Gitea/Forgejo issue comments, GitLab merge
 * request notes, Bitbucket Cloud pull request comments): made once, then edited in place. The
 * comment is found again by a hidden marker in its text.
 */

type Credential = typeof schema.gitCredential.$inferSelect;

/**
 * The hidden marker of the preview comment on one pull request. It holds a tag only this instance
 * can make (keyed with its secret): anyone may comment on a pull request, and a fixed marker copied
 * into their comment would have Serve edit theirs.
 */
export function previewMarker(repository: string, number: number, bitbucket = false) {
  const tag = hmac(`preview-comment:${repository}#${number}`).slice(0, 24);
  // Bitbucket shows raw HTML as text; an empty link reference renders as nothing.
  return bitbucket ? `[//]: # (serve-preview ${tag})` : `<!-- serve-preview ${tag} -->`;
}

type Existing = { id: number; text: string };
type CommentApi = {
  list: string;
  create: string;
  update: (id: number) => string;
  updateMethod: "PATCH" | "PUT";
  payload: (body: string) => unknown;
  read: (json: unknown) => Existing[];
  marker: string;
};

const array = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

/** Where and how each provider lists, creates and edits a pull request's comments. */
export function commentApi(provider: StatusProvider, api: string, repo: string, number: number, marker: string): CommentApi {
  if (provider === "gitlab") {
    const notes = `${api}/projects/${encodeURIComponent(repo)}/merge_requests/${number}/notes`;
    return {
      list: `${notes}?per_page=100&order_by=created_at&sort=asc`,
      create: notes,
      update: (id) => `${notes}/${id}`,
      updateMethod: "PUT",
      payload: (body) => ({ body }),
      read: (json) =>
        array(json)
          .filter((n) => !n.system)
          .map((n) => ({ id: Number(n.id), text: String(n.body ?? "") })),
      marker,
    };
  }
  if (provider === "bitbucket") {
    const comments = `${api}/repositories/${repo}/pullrequests/${number}/comments`;
    return {
      list: `${comments}?pagelen=100`,
      create: comments,
      update: (id) => `${comments}/${id}`,
      updateMethod: "PUT",
      payload: (body) => ({ content: { raw: body } }),
      read: (json) =>
        array((json as { values?: unknown } | null)?.values)
          .filter((c) => !c.deleted)
          .map((c) => ({ id: Number(c.id), text: String((c.content as { raw?: unknown } | undefined)?.raw ?? "") })),
      marker,
    };
  }
  // GitHub and Gitea/Forgejo share the issue comments API.
  const comments = `${api}/repos/${repo}/issues/${number}/comments`;
  return {
    // Gitea lists every comment of an issue at once.
    list: provider === "github" ? `${comments}?per_page=100` : comments,
    create: comments,
    update: (id) => `${api}/repos/${repo}/issues/comments/${id}`,
    updateMethod: "PATCH",
    payload: (body) => ({ body }),
    read: (json) => array(json).map((c) => ({ id: Number(c.id), text: String(c.body ?? "") })),
    marker,
  };
}

const NAMES: Record<StatusProvider, string> = { github: "GitHub", gitlab: "GitLab", gitea: "Gitea", bitbucket: "Bitbucket" };

async function tokenFor(cred: Credential) {
  if (cred.provider === "github-app") return (await import("./github-app")).installationToken(cred);
  return (await import("./oauth")).credentialToken(cred);
}

/**
 * Writes `body` into the pull request's preview comment: edits the one Serve made before, or makes
 * it (only with `create`). Throws with a message that never holds the token.
 */
export async function upsertPreviewComment(cred: Credential, repository: string, number: number, body: string, opts: { create: boolean }): Promise<"created" | "updated" | "none"> {
  const provider = statusProvider(cred.provider);
  if (!provider) return "none";
  const name = NAMES[provider];
  // The credential's own host (Bitbucket Cloud: always its API), and the service's own repository.
  const repo = repoPath(repository, cred.baseUrl);
  const c = commentApi(provider, apiBase(provider, cred.baseUrl), repo, number, previewMarker(`${provider}:${cred.baseUrl ?? ""}:${repo}`, number, provider === "bitbucket"));
  const token = await tokenFor(cred);
  const headers = {
    ...(cred.provider === "github-app" ? { authorization: `Bearer ${token}` } : authHeaders(cred.provider, token, { oauth: !!cred.oauthAppId })),
    accept: provider === "github" ? "application/vnd.github+json" : "application/json",
    "content-type": "application/json",
  };
  const target = { selfHosted: !!cred.baseUrl?.trim(), organizationId: cred.organizationId };
  const call = async (url: string, method: string, payload?: unknown) => {
    const res = await gitHttp(url, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) }, target);
    if (!res.ok) throw new Error(`${name} answered HTTP ${res.status} to ${method} ${new URL(url).pathname}`);
    return res.text;
  };
  let found: Existing | undefined;
  try {
    found = c.read(JSON.parse(await call(c.list, "GET"))).find((e) => e.text.includes(c.marker));
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error(`${name} did not answer with JSON`);
    throw e;
  }
  const text = `${c.marker}\n${body}`;
  if (found) {
    await call(c.update(found.id), c.updateMethod, c.payload(text));
    return "updated";
  }
  if (!opts.create) return "none";
  await call(c.create, "POST", c.payload(text));
  return "created";
}
