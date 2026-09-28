import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { timingSafeEqual } from "@/server/crypto";
import { queueDeployment } from "@/server/services/create";

async function handle(request: NextRequest, serviceId: string) {
  const token = request.nextUrl.searchParams.get("token") ?? request.headers.get("x-deploy-token") ?? "";
  const [service] = await db.select().from(schema.service).where(eq(schema.service.id, serviceId));
  if (!service || !token || !timingSafeEqual(token, service.webhookSecret)) {
    return NextResponse.json({ error: "Invalid deploy hook" }, { status: 401 });
  }
  const id = await queueDeployment(service.id, "deploy-hook");
  return NextResponse.json({ ok: true, deploymentId: id });
}

export async function POST(request: NextRequest, ctx: RouteContext<"/api/deploy-hooks/[serviceId]">) {
  return handle(request, (await ctx.params).serviceId);
}

export async function GET(request: NextRequest, ctx: RouteContext<"/api/deploy-hooks/[serviceId]">) {
  return handle(request, (await ctx.params).serviceId);
}
