import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { timingSafeEqual } from "@/server/crypto";
import { applyPullRequest, applyPush, parsePullRequest, parsePush } from "@/server/git/events";

const hmac = (secret: string, body: string) => crypto.createHmac("sha256", secret).update(body).digest("hex");

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
  if (prEvent) return NextResponse.json({ ok: true, ...(await applyPullRequest(service, prEvent)) });

  const push = parsePush(request.headers, body);
  if (push === "ping") return NextResponse.json({ ok: true, message: "pong" });
  if (!push) return NextResponse.json({ ok: true, skipped: "Not a push event" });
  return NextResponse.json({ ok: true, ...(await applyPush(service, push)) });
}
