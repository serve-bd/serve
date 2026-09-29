import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { queueDeployment } from "@/server/services/create";
import { commentOnGithub, deployPreview, removePreview, type PullRequest } from "@/server/services/previews";
import { matchesWatchPaths } from "@/server/deploy/options";

type Service = typeof schema.service.$inferSelect;

export type PushInfo = {
  branch: string | null;
  sha: string | null;
  message: string | null;
  author: string | null;
  /** Files changed by the pushed commits; null when the provider does not send them. */
  files?: string[] | null;
};

/** Changed files from GitHub, Gitea and GitLab push payloads (commits[].added/modified/removed). */
function changedFiles(body: Record<string, unknown>): string[] | null {
  const commits = body.commits as { added?: string[]; modified?: string[]; removed?: string[] }[] | undefined;
  if (!Array.isArray(commits) || !commits.length) return null;
  const files = new Set<string>();
  let known = false;
  for (const c of commits) {
    for (const list of [c.added, c.modified, c.removed]) {
      if (!Array.isArray(list)) continue;
      known = true;
      for (const f of list) files.add(f);
    }
  }
  // GitHub caps commits at 20 per payload; beyond that the list is incomplete, so deploy.
  if (!known || commits.length >= 20) return null;
  return [...files];
}

export type PrEvent = { action: "deploy" | "close" | "fork"; pr: PullRequest };

export function parsePullRequest(headers: Headers, body: Record<string, unknown>): PrEvent | null {
  const ghEvent = headers.get("x-github-event") ?? headers.get("x-gitea-event");
  if (ghEvent === "pull_request") {
    const action = String(body.action ?? "");
    const pr = body.pull_request as {
      number: number;
      title: string;
      head: { ref: string; sha: string; repo?: { clone_url?: string; full_name?: string } };
      base?: { repo?: { full_name?: string } };
      user?: { login?: string };
    };
    const repo = body.repository as { full_name?: string } | undefined;
    if (!pr) return null;
    const info: PullRequest = {
      number: pr.number ?? (body.number as number),
      branch: pr.head.ref,
      repository: pr.head.repo?.clone_url ?? "",
      title: pr.title,
      sha: pr.head.sha,
      author: pr.user?.login ?? null,
      fullName: repo?.full_name ?? null,
    };
    // Pull requests from forks would run untrusted code with this service's variables.
    const fromFork = !!pr.head.repo?.full_name && !!pr.base?.repo?.full_name && pr.head.repo.full_name !== pr.base.repo.full_name;
    if (action === "closed") return { action: "close", pr: info };
    if (fromFork) return { action: "fork", pr: info };
    if (["opened", "reopened", "synchronize", "synchronized", "ready_for_review"].includes(action)) return { action: "deploy", pr: info };
    return null;
  }
  const bbEvent = headers.get("x-event-key");
  if (bbEvent?.startsWith("pullrequest:")) {
    const pr = body.pullrequest as {
      id: number;
      title: string;
      author?: { display_name?: string; nickname?: string };
      source: { branch: { name: string }; commit?: { hash?: string }; repository?: { full_name?: string } };
      destination?: { repository?: { full_name?: string } };
    };
    if (!pr?.source?.branch) return null;
    const sourceRepo = pr.source.repository?.full_name;
    const info: PullRequest = {
      number: pr.id,
      branch: pr.source.branch.name,
      repository: sourceRepo ? `https://bitbucket.org/${sourceRepo}.git` : "",
      title: pr.title,
      sha: pr.source.commit?.hash ?? null,
      author: pr.author?.nickname ?? pr.author?.display_name ?? null,
      fullName: pr.destination?.repository?.full_name ?? null,
    };
    if (bbEvent === "pullrequest:fulfilled" || bbEvent === "pullrequest:rejected") return { action: "close", pr: info };
    if (sourceRepo && pr.destination?.repository?.full_name && sourceRepo !== pr.destination.repository.full_name) return { action: "fork", pr: info };
    if (bbEvent === "pullrequest:created" || bbEvent === "pullrequest:updated") return { action: "deploy", pr: info };
    return null;
  }
  if (headers.get("x-gitlab-event") === "Merge Request Hook") {
    const mr = body.object_attributes as {
      iid: number;
      action?: string;
      state?: string;
      title: string;
      source_branch: string;
      last_commit?: { id: string };
      source?: { git_http_url?: string };
      source_project_id?: number;
      target_project_id?: number;
    };
    if (!mr) return null;
    const info: PullRequest = {
      number: mr.iid,
      branch: mr.source_branch,
      repository: mr.source?.git_http_url ?? "",
      title: mr.title,
      sha: mr.last_commit?.id ?? null,
      author: null,
    };
    if (["close", "merge"].includes(mr.action ?? "")) return { action: "close", pr: info };
    if (mr.source_project_id && mr.target_project_id && mr.source_project_id !== mr.target_project_id) return { action: "fork", pr: info };
    if (["open", "reopen", "update"].includes(mr.action ?? "")) return { action: "deploy", pr: info };
  }
  return null;
}

export function parsePush(headers: Headers, body: Record<string, unknown>): PushInfo | "ping" | null {
  const ghEvent = headers.get("x-github-event") ?? headers.get("x-gitea-event") ?? headers.get("x-gogs-event");
  if (ghEvent === "ping") return "ping";
  const glEvent = headers.get("x-gitlab-event");
  const bbEvent = headers.get("x-event-key");
  if (ghEvent && ghEvent !== "push") return null;
  if (glEvent && glEvent !== "Push Hook") return null;
  if (bbEvent) {
    if (bbEvent === "diagnostics:ping") return "ping";
    if (bbEvent !== "repo:push") return null;
    const change = ((body.push as { changes?: unknown[] })?.changes?.[0] ?? {}) as {
      new?: { name?: string; target?: { hash?: string; message?: string; author?: { raw?: string } } };
    };
    return {
      branch: change.new?.name ?? null,
      sha: change.new?.target?.hash ?? null,
      message: change.new?.target?.message?.trim() ?? null,
      author: change.new?.target?.author?.raw ?? null,
    };
  }
  const ref = typeof body.ref === "string" ? body.ref : "";
  const branch = ref.startsWith("refs/heads/") ? ref.slice(11) : null;
  if (glEvent) {
    const commits = (body.commits as { id: string; message: string; author?: { name?: string } }[]) ?? [];
    const last = commits.at(-1);
    return {
      branch,
      sha: (body.checkout_sha as string) ?? last?.id ?? null,
      message: last?.message?.trim() ?? null,
      author: last?.author?.name ?? (body.user_name as string) ?? null,
      files: changedFiles(body),
    };
  }
  const head = body.head_commit as { id?: string; message?: string; author?: { name?: string } } | undefined;
  return { branch, sha: head?.id ?? (body.after as string) ?? null, message: head?.message?.split("\n")[0] ?? null, author: head?.author?.name ?? null, files: changedFiles(body) };
}

export type EventResult = Record<string, unknown>;

/** Apply a pull request event to a service with preview deployments. */
export async function applyPullRequest(service: Service, event: PrEvent): Promise<EventResult> {
  if (!service.previewsEnabled || service.parentServiceId) return { skipped: "Preview deployments are off" };
  if (event.action === "fork") return { skipped: "Pull requests from forks are not deployed" };
  if (event.action === "close") return { removed: await removePreview(service, event.pr.number) };
  const result = await deployPreview(service, event.pr);
  if (result) {
    const [domain] = await db.select().from(schema.domain).where(eq(schema.domain.serviceId, result.preview.id));
    void commentOnGithub(service, event.pr, domain ? `${domain.https ? "https" : "http"}://${domain.hostname}` : null);
  }
  return { previewServiceId: result?.preview.id, deploymentId: result?.deploymentId };
}

/** Apply a push event: deploy when the branch matches and auto deploy is on. */
export async function applyPush(service: Service, push: PushInfo): Promise<EventResult> {
  if (!service.autoDeploy) return { skipped: "Auto deploy is off" };
  if (service.source?.type !== "git") return { skipped: "Service does not deploy from git" };
  // Tag pushes and branch deletions carry no branch (or no new commit): nothing to deploy.
  if (!push.branch) return { skipped: "Not a branch push (a tag or a deleted branch)" };
  if (!push.sha || /^0+$/.test(push.sha)) return { skipped: `Branch ${push.branch} was deleted` };
  if (push.branch !== service.source.branch) {
    return { skipped: `Push to ${push.branch}, service tracks ${service.source.branch}` };
  }
  if (!matchesWatchPaths(push.files ?? null, service.build?.watchPaths)) {
    return { skipped: "No changed file matches the watch paths" };
  }
  const id = await queueDeployment(service.id, "webhook", { commitSha: push.sha, commitMessage: push.message, branch: push.branch });
  if (push.author) await db.update(schema.deployment).set({ commitAuthor: push.author }).where(eq(schema.deployment.id, id));
  return { deploymentId: id };
}
