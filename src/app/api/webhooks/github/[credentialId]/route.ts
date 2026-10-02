import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { deliveryReplayed } from "@/server/git/signature";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { timingSafeEqual } from "@/server/crypto";
import { forgetToken, readAppSecret, repoFullName, writeAppSecret } from "@/server/git/github-app";
import { applyPullRequest, applyPush, parsePullRequest, parsePush } from "@/server/git/events";
import { readBodyLimited } from "@/server/http-body";

/** Webhook endpoint of a GitHub App created by Serve. Routes events to every matching service. */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/webhooks/github/[credentialId]">) {
  const { credentialId } = await ctx.params;
  // Git providers send at most 25 MB.
  const raw = await readBodyLimited(request, 26 * 1024 * 1024);
  if (raw === null) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  const [cred] = await db.select().from(schema.gitCredential).where(eq(schema.gitCredential.id, credentialId));
  if (cred?.provider !== "github-app") return NextResponse.json({ error: "Unknown app" }, { status: 404 });
  const secret = readAppSecret(cred);
  // An app whose setup never finished has no webhook secret: nothing can be signed for it.
  if (!secret.webhookSecret) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  const expected = `sha256=${crypto.createHmac("sha256", secret.webhookSecret).update(raw).digest("hex")}`;
  if (!timingSafeEqual(signature, expected)) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  if (deliveryReplayed(request.headers)) return NextResponse.json({ ok: true, skipped: "duplicate delivery" });

  const event = request.headers.get("x-github-event");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Expected a JSON payload" }, { status: 400 });
  }

  if (event === "ping") return NextResponse.json({ ok: true, message: "pong" });
  if (event === "installation") {
    const action = body.action as string;
    const installation = body.installation as { id: number; account?: { login?: string } };
    if (action === "deleted" && secret.installationId === installation.id) {
      await writeAppSecret(cred.id, { ...secret, installationId: null });
      forgetToken(cred.id);
    } else if (action === "created" && !secret.installationId) {
      await writeAppSecret(cred.id, { ...secret, installationId: installation.id, account: installation.account?.login ?? secret.account });
    }
    return NextResponse.json({ ok: true });
  }
  if (event !== "push" && event !== "pull_request") return NextResponse.json({ ok: true, skipped: `Ignored ${event}` });

  const repo = (body.repository as { full_name?: string } | undefined)?.full_name?.toLowerCase();
  if (!repo) return NextResponse.json({ ok: true, skipped: "No repository" });
  const linked = await db
    .select()
    .from(schema.service)
    .where(and(sql`${schema.service.source}->>'credentialId' = ${cred.id}`, isNull(schema.service.parentServiceId)));
  const services = linked.filter((s) => s.source?.type === "git" && repoFullName(s.source.repository) === repo);

  const results: Record<string, unknown>[] = [];
  if (event === "pull_request") {
    const pr = parsePullRequest(request.headers, body);
    if (pr) for (const s of services) results.push({ service: s.id, ...(await applyPullRequest(s, pr)) });
  } else {
    const push = parsePush(request.headers, body);
    if (push && push !== "ping") for (const s of services) results.push({ service: s.id, ...(await applyPush(s, push)) });
  }
  return NextResponse.json({ ok: true, repository: repo, results });
}
