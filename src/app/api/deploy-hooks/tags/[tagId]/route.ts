import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { timingSafeEqual } from "@/server/crypto";
import { deployTag } from "@/server/tags";

/** Deploys every service with the tag, like each service's own deploy hook. */
async function handle(request: NextRequest, tagId: string) {
  const token = request.nextUrl.searchParams.get("token") ?? request.headers.get("x-deploy-token") ?? "";
  const [tag] = await db.select().from(schema.tag).where(eq(schema.tag.id, tagId));
  if (!tag || !token || !timingSafeEqual(token, tag.deploySecret)) {
    return NextResponse.json({ error: "Invalid deploy hook" }, { status: 401 });
  }
  const { queued, skipped } = await deployTag(tag.id, { trigger: "deploy-hook" });
  // ok is false when any service was skipped (a freeze, a full queue), so CI does not report success for it.
  return NextResponse.json({ ok: skipped.length === 0, deployments: queued, skipped });
}

export async function POST(request: NextRequest, ctx: RouteContext<"/api/deploy-hooks/tags/[tagId]">) {
  return handle(request, (await ctx.params).tagId);
}

export async function GET(request: NextRequest, ctx: RouteContext<"/api/deploy-hooks/tags/[tagId]">) {
  return handle(request, (await ctx.params).tagId);
}
