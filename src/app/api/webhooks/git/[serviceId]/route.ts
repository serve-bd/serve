import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { timingSafeEqual } from "@/server/crypto";
import { queueDeployment } from "@/server/services/create";
import { commentOnGithub, deployPreview, removePreview, type PullRequest } from "@/server/services/previews";

type PrEvent = { action: "deploy" | "close"; pr: PullRequest };

function parsePullRequest(headers: Headers, body: Record<string, unknown>): PrEvent | null {
  const ghEvent = headers.get("x-github-event") ?? headers.get("x-gitea-event");
  if (ghEvent === "pull_request") {
    const action = String(body.action ?? "");
    const pr = body.pull_request as {
      number: number;
      title: string;
      head: { ref: string; sha: string; repo?: { clone_url?: string } };
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
    if (["opened", "reopened", "synchronize", "synchronized", "ready_for_review"].includes(action)) return { action: "deploy", pr: info };
    if (action === "closed") return { action: "close", pr: info };
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
    };
    if (!mr) return null;
    const info: PullRequest = { number: mr.iid, branch: mr.source_branch, repository: mr.source?.git_http_url ?? "", title: mr.title, sha: mr.last_commit?.id ?? null, author: null };
    if (["open", "reopen", "update"].includes(mr.action ?? "")) return { action: "deploy", pr: info };
    if (["close", "merge"].includes(mr.action ?? "")) return { action: "close", pr: info };
  }
  return null;
}

const hmac = (secret: string, body: string) => crypto.createHmac("sha256", secret).update(body).digest("hex");

type PushInfo = { branch: string | null; sha: string | null; message: string | null; author: string | null };

function parsePush(headers: Headers, body: Record<string, unknown>): PushInfo | "ping" | null {
  const ghEvent = headers.get("x-github-event") ?? headers.get("x-gitea-event") ?? headers.get("x-gogs-event");
  if (ghEvent === "ping") return "ping";
  const glEvent = headers.get("x-gitlab-event");
  const bbEvent = headers.get("x-event-key");
  if (ghEvent && ghEvent !== "push") return null;
  if (glEvent && glEvent !== "Push Hook") return null;
  if (bbEvent) {
    if (bbEvent !== "repo:push") return null;
    const change = ((body.push as { changes?: unknown[] })?.changes?.[0] ?? {}) as { new?: { name?: string; target?: { hash?: string; message?: string; author?: { raw?: string } } } };
    return { branch: change.new?.name ?? null, sha: change.new?.target?.hash ?? null, message: change.new?.target?.message?.trim() ?? null, author: change.new?.target?.author?.raw ?? null };
  }
  const ref = typeof body.ref === "string" ? body.ref : "";
  const branch = ref.startsWith("refs/heads/") ? ref.slice(11) : null;
  if (glEvent) {
    const commits = (body.commits as { id: string; message: string; author?: { name?: string } }[]) ?? [];
    const last = commits.at(-1);
    return { branch, sha: (body.checkout_sha as string) ?? last?.id ?? null, message: last?.message?.trim() ?? null, author: last?.author?.name ?? (body.user_name as string) ?? null };
  }
  const head = body.head_commit as { id?: string; message?: string; author?: { name?: string } } | undefined;
  return { branch, sha: head?.id ?? (body.after as string) ?? null, message: head?.message?.split("\n")[0] ?? null, author: head?.author?.name ?? null };
}

export async function POST(request: NextRequest, ctx: RouteContext<"/api/webhooks/git/[serviceId]">) {
  const { serviceId } = await ctx.params;
  const raw = await request.text();
  const [service] = await db.select().from(schema.service).where(eq(schema.service.id, serviceId));
  if (!service) return NextResponse.json({ error: "Unknown service" }, { status: 404 });

  const secret = service.webhookSecret;
  const gh = request.headers.get("x-hub-signature-256");
  const gitea = request.headers.get("x-gitea-signature") ?? request.headers.get("x-gogs-signature");
  const gitlab = request.headers.get("x-gitlab-token");
  const query = request.nextUrl.searchParams.get("secret");
  const valid =
    (gh && timingSafeEqual(gh, `sha256=${hmac(secret, raw)}`)) ||
    (gitea && timingSafeEqual(gitea, hmac(secret, raw))) ||
    (gitlab && timingSafeEqual(gitlab, secret)) ||
    (query && timingSafeEqual(query, secret));
  if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ error: "Expected a JSON payload" }, { status: 400 });
  }
  const prEvent = parsePullRequest(request.headers, body);
  if (prEvent) {
    if (!service.previewsEnabled || service.parentServiceId) return NextResponse.json({ ok: true, skipped: "Preview deployments are off" });
    if (prEvent.action === "close") {
      const removed = await removePreview(service, prEvent.pr.number);
      return NextResponse.json({ ok: true, removed });
    }
    const result = await deployPreview(service, prEvent.pr);
    if (result) {
      const [domain] = await db.select().from(schema.domain).where(eq(schema.domain.serviceId, result.preview.id));
      void commentOnGithub(service, prEvent.pr, domain ? `${domain.https ? "https" : "http"}://${domain.hostname}` : null);
    }
    return NextResponse.json({ ok: true, previewServiceId: result?.preview.id, deploymentId: result?.deploymentId });
  }

  const push = parsePush(request.headers, body);
  if (push === "ping") return NextResponse.json({ ok: true, message: "pong" });
  if (!push) return NextResponse.json({ ok: true, skipped: "Not a push event" });
  if (!service.autoDeploy) return NextResponse.json({ ok: true, skipped: "Auto deploy is off" });
  if (service.source?.type !== "git") return NextResponse.json({ ok: true, skipped: "Service does not deploy from git" });
  if (push.branch && push.branch !== service.source.branch) {
    return NextResponse.json({ ok: true, skipped: `Push to ${push.branch}, service tracks ${service.source.branch}` });
  }
  const id = await queueDeployment(service.id, "webhook", {
    commitSha: push.sha,
    commitMessage: push.message,
    branch: push.branch,
  });
  if (push.author) await db.update(schema.deployment).set({ commitAuthor: push.author }).where(eq(schema.deployment.id, id));
  return NextResponse.json({ ok: true, deploymentId: id });
}
