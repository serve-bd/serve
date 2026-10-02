import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { deliveryReplayed, verifyWebhookSignature } from "@/server/git/signature";
import { applyPullRequest, applyPush, parsePullRequest, parsePush } from "@/server/git/events";
import { readBodyLimited } from "@/server/http-body";

export async function POST(request: NextRequest, ctx: RouteContext<"/api/webhooks/git/[serviceId]">) {
  const { serviceId } = await ctx.params;
  // Git providers send at most 25 MB.
  const raw = await readBodyLimited(request, 26 * 1024 * 1024);
  if (raw === null) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  const [service] = await db.select().from(schema.service).where(eq(schema.service.id, serviceId));
  if (!service) return NextResponse.json({ error: "Unknown service" }, { status: 404 });

  const valid = verifyWebhookSignature(request.headers, raw, service.webhookSecret, request.nextUrl.searchParams.get("secret"));
  if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  if (deliveryReplayed(request.headers)) return NextResponse.json({ ok: true, skipped: "duplicate delivery" });

  let body: Record<string, unknown>;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ error: "Expected a JSON payload" }, { status: 400 });
  }
  const prEvent = parsePullRequest(request.headers, body);
  if (prEvent) return NextResponse.json({ ok: true, ...(await applyPullRequest(service, prEvent)) });

  const push = parsePush(request.headers, body);
  if (push === "ping") return NextResponse.json({ ok: true, message: "pong" });
  if (!push) return NextResponse.json({ ok: true, skipped: "Not a push event" });
  return NextResponse.json({ ok: true, ...(await applyPush(service, push)) });
}
