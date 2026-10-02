import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import type { GitSource, RepoWebhook } from "@/server/services/types";
import { apiBase, authHeaders } from "./providers";
import { gitHttp } from "./http";
import { withCredentialToken } from "./oauth";
import { webhookBaseUrl } from "./public-url";

type Service = typeof schema.service.$inferSelect;
type Credential = typeof schema.gitCredential.$inferSelect;
export type HookProvider = RepoWebhook["provider"];

const labels: Record<HookProvider, string> = { github: "GitHub", gitlab: "GitLab", gitea: "Gitea", bitbucket: "Bitbucket" };

/** Providers Serve can manage webhooks on (GitHub App credentials get events from the app instead). */
export function hookProvider(cred: Pick<Credential, "provider"> | null | undefined): HookProvider | null {
  const p = cred?.provider;
  return p === "github" || p === "gitlab" || p === "gitea" || p === "bitbucket" ? p : null;
}

/**
 * "owner/repo" (GitLab: "group/subgroup/repo") from an https or ssh clone URL.
 * A self-hosted base URL with a path prefix (https://host/git) is removed first.
 */
export function repoPath(repository: string, baseUrl?: string | null) {
  let rest = repository.trim();
  const base = baseUrl?.replace(/\/$/, "");
  if (base && rest.startsWith(base + "/")) rest = rest.slice(base.length + 1);
  else if (/^[\w.+-]+@[^:/]+:/.test(rest)) rest = rest.replace(/^[\w.+-]+@[^:]+:/, "");
  else {
    try {
      rest = new URL(rest).pathname.slice(1);
    } catch {
      // owner/repo shorthand
    }
  }
  const path = rest.replace(/\.git$/, "").replace(/\/+$/, "");
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(path)) throw new Error(`Could not read the repository path from ${repository}.`);
  return path;
}

export type HookRequest = { method: "POST" | "DELETE"; url: string; body?: unknown };

/** Provider API request that creates a push + pull request webhook. */
export function createHookRequest(provider: HookProvider, api: string, path: string, url: string, secret: string, label = "Serve"): HookRequest {
  switch (provider) {
    case "gitlab":
      return {
        method: "POST",
        url: `${api}/projects/${encodeURIComponent(path)}/hooks`,
        body: { url, token: secret, push_events: true, merge_requests_events: true, enable_ssl_verification: url.startsWith("https://") },
      };
    case "gitea":
      return {
        method: "POST",
        url: `${api}/repos/${path}/hooks`,
        body: { type: "gitea", active: true, events: ["push", "pull_request"], config: { url, content_type: "json", secret } },
      };
    case "bitbucket":
      return {
        method: "POST",
        url: `${api}/repositories/${path}/hooks`,
        body: {
          description: label,
          url,
          active: true,
          secret,
          events: ["repo:push", "pullrequest:created", "pullrequest:updated", "pullrequest:fulfilled", "pullrequest:rejected"],
        },
      };
    case "github":
      return {
        method: "POST",
        url: `${api}/repos/${path}/hooks`,
        body: { name: "web", active: true, events: ["push", "pull_request"], config: { url, content_type: "json", secret, insecure_ssl: "0" } },
      };
  }
}

export function deleteHookRequest(provider: HookProvider, api: string, path: string, id: string): HookRequest {
  if (provider === "gitlab") return { method: "DELETE", url: `${api}/projects/${encodeURIComponent(path)}/hooks/${id}` };
  if (provider === "bitbucket") return { method: "DELETE", url: `${api}/repositories/${path}/hooks/${encodeURIComponent(id)}` };
  return { method: "DELETE", url: `${api}/repos/${path}/hooks/${id}` };
}

async function send(req: HookRequest, headers: Record<string, string>, cred: { baseUrl: string | null; organizationId: string }) {
  const res = await gitHttp(
    req.url,
    { method: req.method, headers: { accept: "application/json", "content-type": "application/json", ...headers }, body: req.body ? JSON.stringify(req.body) : undefined },
    { selfHosted: !!cred.baseUrl?.trim(), organizationId: cred.organizationId },
  );
  if (res.status === 401) throw new Error("401: the token was rejected.");
  if (req.method === "DELETE" && res.status === 404) return null;
  if (!res.ok) {
    const detail = res.text.match(/"(?:message|error_description|error)"\s*:\s*"([^"]+)"/)?.[1];
    if (res.status === 403 || res.status === 404)
      throw new Error(`The token cannot manage webhooks on this repository (HTTP ${res.status}). ${detail ?? "Give it webhook or admin access."}`);
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  if (res.status === 204) return null;
  try {
    return JSON.parse(res.text) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

function hookId(provider: HookProvider, res: Record<string, unknown> | null) {
  const id = provider === "bitbucket" ? res?.uuid : res?.id;
  if (id === undefined || id === null) throw new Error("The provider did not return a webhook id.");
  return String(id);
}

async function credentialFor(source: GitSource) {
  if (!source.credentialId) return null;
  const [cred] = await db.select().from(schema.gitCredential).where(eq(schema.gitCredential.id, source.credentialId));
  return cred ?? null;
}

async function saveWebhook(serviceId: string, webhook: RepoWebhook | null) {
  const [row] = await db.select({ source: schema.service.source }).from(schema.service).where(eq(schema.service.id, serviceId));
  if (row?.source?.type !== "git") return;
  await db
    .update(schema.service)
    .set({ source: { ...row.source, webhook } })
    .where(eq(schema.service.id, serviceId));
}

/** Delete the remote hook recorded on a source. Never throws. */
export async function removeRepoWebhook(source: GitSource | null | undefined): Promise<string | null> {
  const hook = source?.webhook;
  if (!source || !hook?.id) return null;
  try {
    const cred = await credentialFor(source);
    const provider = hookProvider(cred);
    if (!cred || !provider) return null;
    const req = deleteHookRequest(provider, apiBase(provider, cred.baseUrl), repoPath(source.repository, cred.baseUrl), hook.id);
    await withCredentialToken(cred, (token) => send(req, authHeaders(provider, token, { oauth: !!cred.oauthAppId }), cred));
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * Register (or re-register) the deploy webhook of a git service through the provider API
 * and record the result on the service. Never throws: failures are stored as `error`.
 * Returns null when the credential cannot manage webhooks (SSH keys, public repos).
 */
export async function registerRepoWebhook(serviceId: string): Promise<RepoWebhook | null> {
  const [service] = await db.select().from(schema.service).where(eq(schema.service.id, serviceId));
  if (!service || service.parentServiceId || service.source?.type !== "git") return null;
  const source = service.source;
  const cred = await credentialFor(source);
  const provider = hookProvider(cred);
  if (!cred || !provider) {
    if (source.webhook) await saveWebhook(serviceId, null);
    return null;
  }
  const now = new Date().toISOString();
  const base = await webhookBaseUrl(labels[provider]);
  if (!base.ok) {
    // Keep a hook registered earlier; it still works until it is replaced.
    const webhook: RepoWebhook = source.webhook?.id ? { ...source.webhook, error: base.error } : { provider, id: null, url: null, createdAt: now, error: base.error };
    await saveWebhook(serviceId, webhook);
    return webhook;
  }
  const url = `${base.url}/api/webhooks/git/${service.id}`;
  let webhook: RepoWebhook;
  try {
    // Replace an earlier hook so a changed dashboard address never leaves a stale one behind.
    if (source.webhook?.id) await removeRepoWebhook(source);
    const { productName } = await import("@/server/branding");
    const req = createHookRequest(provider, apiBase(provider, cred.baseUrl), repoPath(source.repository, cred.baseUrl), url, service.webhookSecret, await productName());
    const res = await withCredentialToken(cred, (token) => send(req, authHeaders(provider, token, { oauth: !!cred.oauthAppId }), cred));
    webhook = { provider, id: hookId(provider, res), url, createdAt: now, error: null };
  } catch (e) {
    webhook = { provider, id: null, url, createdAt: now, error: (e as Error).message.replace(/^401: /, "") };
  }
  await saveWebhook(serviceId, webhook);
  return webhook;
}

/** After a source change: drop the old repository's hook and register on the new one. */
export async function syncRepoWebhook(before: Service["source"], serviceId: string) {
  const [service] = await db.select({ source: schema.service.source }).from(schema.service).where(eq(schema.service.id, serviceId));
  const after = service?.source;
  const same = before?.type === "git" && after?.type === "git" && before.repository === after.repository && (before.credentialId ?? null) === (after.credentialId ?? null);
  if (same) {
    // Keep the existing hook on the unchanged repository.
    if (before.webhook && !after.webhook) await saveWebhook(serviceId, before.webhook);
    return;
  }
  if (before?.type === "git") await removeRepoWebhook(before);
  if (after?.type === "git") await registerRepoWebhook(serviceId);
}
