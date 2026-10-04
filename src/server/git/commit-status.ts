import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import type { DeploymentStatus, GitProviderType } from "@/server/db/schema";
import { apiBase, authHeaders } from "./providers";

/**
 * Commit statuses: each deployment of a git app reports its state on the commit it deploys, so the
 * provider shows a check next to the commit and on its pull request. Best effort: the reports run
 * as worker jobs, and a slow or failing provider never holds up or fails a deploy.
 */

type Credential = typeof schema.gitCredential.$inferSelect;
export type StatusProvider = "github" | "gitlab" | "gitea" | "bitbucket";

/** A deployment's state in provider-neutral words. */
export type CommitState = "pending" | "running" | "success" | "failure" | "cancelled";
export type CommitStatus = { state: CommitState; description: string };

const MAX_DESCRIPTION = 140; // GitHub's limit; the others take more.

function short(text: string, max = MAX_DESCRIPTION) {
  const line =
    text
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** What a deployment in `status` reports. */
export function commitStatusFor(dep: { status: DeploymentStatus; error?: string | null }): CommitStatus {
  switch (dep.status) {
    case "waiting":
      return { state: "pending", description: "Waiting for approval" };
    case "queued":
      return { state: "pending", description: "Waiting to build" };
    case "building":
      return { state: "running", description: "Building" };
    case "deploying":
      return { state: "running", description: "Deploying" };
    case "success":
      return { state: "success", description: "Deployed" };
    case "failed":
      return { state: "failure", description: dep.error ? short(`Failed: ${dep.error.replace(/^Error: /, "")}`) : "Failed" };
    case "superseded":
      return { state: "cancelled", description: "Skipped, a newer commit deployed" };
    case "cancelled": {
      // Turned down by an approver, or never started (a freeze, a full queue): say which.
      if (dep.error && /^Rejected by /.test(dep.error)) return { state: "cancelled", description: "Rejected" };
      if (dep.error) return { state: "cancelled", description: short(`Not deployed: ${dep.error}`) };
      return { state: "cancelled", description: "Cancelled" };
    }
  }
}

/** The provider's own word for a state. */
export function providerState(provider: StatusProvider, state: CommitState) {
  if (provider === "gitlab") return { pending: "pending", running: "running", success: "success", failure: "failed", cancelled: "canceled" }[state];
  if (provider === "bitbucket") return { pending: "INPROGRESS", running: "INPROGRESS", success: "SUCCESSFUL", failure: "FAILED", cancelled: "STOPPED" }[state];
  // GitHub, Gitea and Forgejo: no "running" (pending until it ends) and no "cancelled" (error).
  return { pending: "pending", running: "pending", success: "success", failure: "failure", cancelled: "error" }[state];
}

export type StatusRequest = { method: "POST"; url: string; body: Record<string, unknown> };

/** The API request that sets a commit status. */
export function statusRequest(
  provider: StatusProvider,
  target: { api: string; repo: string; sha: string; context: string; key: string; targetUrl: string | null },
  status: CommitStatus,
): StatusRequest {
  const state = providerState(provider, status.state);
  const { api, repo, sha, context, targetUrl } = target;
  if (provider === "gitlab")
    return {
      method: "POST",
      url: `${api}/projects/${encodeURIComponent(repo)}/statuses/${sha}`,
      body: { state, name: context, description: status.description, ...(targetUrl ? { target_url: targetUrl } : {}) },
    };
  if (provider === "bitbucket")
    return {
      method: "POST",
      url: `${api}/repositories/${repo}/commit/${sha}/statuses/build`,
      // Bitbucket wants a link; without a public dashboard it points at the commit's own page.
      body: { key: target.key, state, name: context, description: status.description, url: targetUrl ?? `https://bitbucket.org/${repo}/commits/${sha}` },
    };
  return {
    method: "POST",
    url: `${api}/repos/${repo}/statuses/${sha}`,
    body: { state, context, description: status.description, ...(targetUrl ? { target_url: targetUrl } : {}) },
  };
}

/** Name of the check: several services (and environments, and previews) on one repository each get their own. */
export function statusContext(product: string, service: { name: string; preview: boolean; environment: string | null }) {
  const env = service.environment && service.environment !== "production" ? ` (${service.environment})` : "";
  return `${product} / ${service.name}${service.preview ? " (preview)" : env}`;
}

/** The provider the credential reports through, or null when it cannot (an SSH deploy key). */
export function statusProvider(provider: GitProviderType): StatusProvider | null {
  if (provider === "github-app" || provider === "github") return "github";
  if (provider === "gitlab" || provider === "gitea" || provider === "bitbucket") return provider;
  return null;
}

/** What to tell the user when the provider refused for lack of permission. */
export function permissionHint(provider: GitProviderType) {
  switch (provider) {
    case "github-app":
      return "GitHub refused the status: the app needs the Commit statuses permission. Accept the new permission in GitHub.";
    case "github":
      return "GitHub refused the status: the token needs the repo:status scope (Commit statuses: read and write for a fine-grained token).";
    case "gitlab":
      return "GitLab refused the status: the token needs the api scope and at least the Developer role.";
    case "gitea":
      return "Gitea refused the status: the token needs the write:repository scope.";
    case "bitbucket":
      return "Bitbucket refused the status: the token needs write access to the repository.";
    default:
      return "The provider refused the status.";
  }
}

export type SendOutcome = { ok: true } | { ok: false; permission: boolean; retry: boolean; message: string };

/** How a provider's answer is read. GitLab refuses a repeated state ("running" twice): that is no error. */
export function readAnswer(provider: GitProviderType, res: { status: number; text: string }): SendOutcome {
  if (res.status >= 200 && res.status < 300) return { ok: true };
  if (provider === "gitlab" && res.status === 400 && /Cannot transition status/i.test(res.text)) return { ok: true };
  let detail = "";
  try {
    const j = JSON.parse(res.text) as { message?: unknown; error?: unknown };
    const m = j.message ?? j.error;
    detail = typeof m === "string" ? m : m && typeof m === "object" && "message" in m ? String((m as { message: unknown }).message) : "";
  } catch {}
  const name = ({ github: "GitHub", "github-app": "GitHub", gitlab: "GitLab", gitea: "Gitea", bitbucket: "Bitbucket" } as Record<string, string>)[provider] ?? "The provider";
  // Private repositories answer 404 to a token that cannot see them.
  if (res.status === 401 || res.status === 403 || res.status === 404) return { ok: false, permission: true, retry: false, message: permissionHint(provider) };
  const message = `${name} answered HTTP ${res.status}${detail ? `: ${short(detail, 200)}` : ""}`;
  return { ok: false, permission: false, retry: res.status === 429 || res.status >= 500, message };
}

/* -------------------------------------------------------------------------- */
/*                    Refusals, remembered per credential                     */
/* -------------------------------------------------------------------------- */

/** A refusal is not retried on every deploy: the next try waits this long. */
export const BLOCK_MS = 30 * 60_000;
export const BLOCK_PREFIX = "commitStatusBlock:";

export type Block = { message: string; until: number };

export async function blockedFor(credentialId: string): Promise<Block | null> {
  const [row] = await db
    .select()
    .from(schema.setting)
    .where(eq(schema.setting.key, `${BLOCK_PREFIX}${credentialId}`));
  const block = row?.value as Block | undefined;
  return block && block.until > Date.now() ? block : null;
}

async function block(credentialId: string, message: string) {
  const value: Block = { message, until: Date.now() + BLOCK_MS };
  await db
    .insert(schema.setting)
    .values({ key: `${BLOCK_PREFIX}${credentialId}`, value })
    .onConflictDoUpdate({ target: schema.setting.key, set: { value, updatedAt: new Date() } });
}

/** Forget a refusal (the permission was granted, or a status went through). */
export async function clearCommitStatusBlock(credentialId: string) {
  await db.delete(schema.setting).where(eq(schema.setting.key, `${BLOCK_PREFIX}${credentialId}`));
}

/** One line in the deployment's log, once per deployment, when its status could not be sent. */
const LOG_MARK = "Commit status not sent: ";
async function logOnce(deploymentId: string, message: string) {
  const line = `${LOG_MARK}${message}\n`;
  await db
    .update(schema.deployment)
    .set({ logs: sql`${schema.deployment.logs} || ${line}` })
    .where(and(eq(schema.deployment.id, deploymentId), sql`position(${LOG_MARK} in ${schema.deployment.logs}) = 0`));
}

/* -------------------------------------------------------------------------- */
/*                                  Sending                                   */
/* -------------------------------------------------------------------------- */

/** Everything a report needs, read at send time. */
export type ReportContext = {
  deployment: { id: string; status: DeploymentStatus; error: string | null; commitSha: string | null; rollbackOf: string | null; upload: unknown };
  service: { id: string; name: string; projectId: string; preview: boolean; environment: string | null; source: unknown; enabled: boolean };
  credential: Credential | null;
};

export type ReportDeps = {
  load: (deploymentId: string) => Promise<ReportContext | null>;
  blocked: (credentialId: string) => Promise<Block | null>;
  block: (credentialId: string, message: string) => Promise<void>;
  log: (deploymentId: string, message: string) => Promise<void>;
  token: (cred: Credential) => Promise<{ value: string; refresh?: () => Promise<string> }>;
  send: (req: StatusRequest, headers: Record<string, string>, cred: Credential) => Promise<{ status: number; text: string }>;
  baseUrl: () => Promise<string | null>;
  product: () => Promise<string>;
};

export type ReportResult = "sent" | "skipped" | "stale" | "blocked" | "refused" | "failed";

/** Error for a failure worth another try (the provider was down): the job runs it again. */
export class CommitStatusRetry extends Error {}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

/**
 * Sends the deployment's state to its git provider. `expected` is the state the job was queued
 * for: when the deployment has moved on, the job for the newer state sends that one instead, so a
 * late job never puts an older state back. `last`: no retry follows a transient failure.
 */
export async function reportCommitStatus(deploymentId: string, expected?: DeploymentStatus, opts: { last?: boolean } = {}, deps: ReportDeps = defaultDeps): Promise<ReportResult> {
  const ctx = await deps.load(deploymentId);
  if (!ctx) return "skipped";
  const { deployment: dep, service, credential: cred } = ctx;
  if (expected && dep.status !== expected) return "stale";
  const source = service.source as { type?: string; repository?: string } | null;
  // Only commits built from a repository: a rollback reuses an older image, an upload may hold changes never pushed.
  if (!service.enabled || source?.type !== "git" || !source.repository || dep.rollbackOf || dep.upload) return "skipped";
  if (!dep.commitSha || !SHA.test(dep.commitSha) || !cred) return "skipped";
  const provider = statusProvider(cred.provider);
  if (!provider) return "skipped";

  const blocked = await deps.blocked(cred.id);
  if (blocked) {
    await deps.log(dep.id, blocked.message);
    return "blocked";
  }
  const { repoPath } = await import("./repo-webhooks");
  let repo: string;
  try {
    repo = repoPath(source.repository, cred.baseUrl);
  } catch (e) {
    await deps.log(dep.id, (e as Error).message);
    return "failed";
  }
  const base = await deps.baseUrl();
  const req = statusRequest(
    provider,
    {
      api: apiBase(provider, cred.baseUrl),
      repo,
      sha: dep.commitSha.toLowerCase(),
      context: statusContext(await deps.product(), service),
      key: `serve-${service.id}`.slice(0, 40),
      targetUrl: base ? `${base}/projects/${service.projectId}/services/${service.id}/deployments/${dep.id}` : null,
    },
    commitStatusFor(dep),
  );

  const headersFor = (token: string): Record<string, string> => ({
    ...(cred.provider === "github-app" ? { authorization: `Bearer ${token}` } : authHeaders(cred.provider, token, { oauth: !!cred.oauthAppId })),
    accept: provider === "github" ? "application/vnd.github+json" : "application/json",
    "content-type": "application/json",
  });
  let token: Awaited<ReturnType<ReportDeps["token"]>>;
  try {
    token = await deps.token(cred);
  } catch (e) {
    // No token (an app removed on GitHub, an OAuth connection that needs reconnecting): the reason as it is.
    await deps.log(dep.id, (e as Error).message);
    return "failed";
  }
  let outcome: SendOutcome;
  try {
    let res = await deps.send(req, headersFor(token.value), cred);
    // A token that expired early (OAuth, an app's installation token): once more with a fresh one.
    // An app's token also carries the permissions it had when made: a 403 may be from before they were accepted.
    const stale = res.status === 401 || (res.status === 403 && cred.provider === "github-app");
    if (stale && token.refresh) res = await deps.send(req, headersFor(await token.refresh()), cred);
    outcome = readAnswer(cred.provider, res);
  } catch (e) {
    // No answer (a timeout, DNS, the server offline): worth another try.
    outcome = { ok: false, permission: false, retry: true, message: `No answer from the provider: ${(e as Error).message || String(e)}` };
  }
  if (outcome.ok) return "sent";
  if (outcome.permission) {
    await deps.block(cred.id, outcome.message);
    await deps.log(dep.id, outcome.message);
    return "refused";
  }
  if (outcome.retry && !opts.last) throw new CommitStatusRetry(outcome.message);
  await deps.log(dep.id, outcome.message);
  return "failed";
}

async function loadContext(deploymentId: string): Promise<ReportContext | null> {
  const [row] = await db
    .select({ deployment: schema.deployment, service: schema.service, environment: schema.environment.name })
    .from(schema.deployment)
    .innerJoin(schema.service, eq(schema.service.id, schema.deployment.serviceId))
    .leftJoin(schema.environment, eq(schema.environment.id, schema.service.environmentId))
    .where(eq(schema.deployment.id, deploymentId));
  if (!row) return null;
  const s = row.service;
  // A preview follows its app's choice, and reports under the app's name.
  const [parent] = s.parentServiceId
    ? await db.select({ name: schema.service.name, source: schema.service.source }).from(schema.service).where(eq(schema.service.id, s.parentServiceId))
    : [null];
  const owner = parent ?? s;
  const enabled = !(owner.source?.type === "git" && owner.source.commitStatuses === false);
  const credentialId = s.source?.type === "git" ? s.source.credentialId : null;
  const [cred] = credentialId ? await db.select().from(schema.gitCredential).where(eq(schema.gitCredential.id, credentialId)) : [null];
  return {
    deployment: row.deployment,
    service: { id: s.id, name: owner.name, projectId: s.projectId, preview: !!parent, environment: row.environment, source: s.source, enabled },
    credential: cred ?? null,
  };
}

const defaultDeps: ReportDeps = {
  load: loadContext,
  blocked: blockedFor,
  block,
  log: logOnce,
  token: async (cred) => {
    if (cred.provider === "github-app") {
      const { forgetToken, installationToken } = await import("./github-app");
      // A cached token can be revoked early (the app was reinstalled): a new one once.
      const refresh = () => {
        forgetToken(cred.id);
        return installationToken(cred);
      };
      return { value: await installationToken(cred), refresh };
    }
    const { credentialToken } = await import("./oauth");
    return { value: await credentialToken(cred), refresh: cred.oauthAppId ? () => credentialToken(cred, { force: true }) : undefined };
  },
  send: async (req, headers, cred) => {
    const { gitHttp } = await import("./http");
    const res = await gitHttp(
      req.url,
      { method: req.method, headers, body: JSON.stringify(req.body), timeoutMs: 15_000 },
      { selfHosted: !!cred.baseUrl?.trim(), organizationId: cred.organizationId },
    );
    return { status: res.status, text: res.text };
  },
  baseUrl: async () => {
    const { preferHttps, publicBaseUrl } = await import("./github-app");
    const { isPublicUrl } = await import("./public-url");
    const url = await publicBaseUrl();
    // A link the provider's users cannot open is left out.
    return isPublicUrl(url) ? (await preferHttps(url)).replace(/\/$/, "") : null;
  },
  product: async () => (await import("@/server/branding")).productName(),
};

/* -------------------------------------------------------------------------- */
/*                                  Queueing                                  */
/* -------------------------------------------------------------------------- */

/**
 * Queues a report of the deployment's current state. Called after every change of state; never
 * throws (a deploy must not fail over it). Only services built from a repository with a git
 * connection get a job. One service's reports run one after another, in the order they were queued.
 */
export async function queueCommitStatus(deploymentId: string) {
  try {
    const [row] = await db
      .select({ status: schema.deployment.status, serviceId: schema.deployment.serviceId, source: schema.service.source })
      .from(schema.deployment)
      .innerJoin(schema.service, eq(schema.service.id, schema.deployment.serviceId))
      .where(eq(schema.deployment.id, deploymentId));
    if (row?.source?.type !== "git" || !row.source.credentialId) return;
    const { enqueue } = await import("@/server/queue");
    await enqueue("commit.status", { deploymentId, status: row.status }, { concurrencyKey: `commit-status:${row.serviceId}`, maxAttempts: 3 });
  } catch (e) {
    console.error(`[commit-status] could not queue a report for ${deploymentId}: ${(e as Error).message}`);
  }
}

/** queueCommitStatus for several deployments (a bulk change of state). */
export async function queueCommitStatuses(deploymentIds: string[]) {
  for (const id of deploymentIds) await queueCommitStatus(id);
}

/** The refusal the service's git connection got lately, for its settings page. */
export async function commitStatusProblem(credentialId: string | null | undefined) {
  if (!credentialId) return null;
  return (await blockedFor(credentialId).catch(() => null))?.message ?? null;
}
