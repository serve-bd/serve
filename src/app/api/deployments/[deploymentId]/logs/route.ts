import { cannotMessage } from "@/lib/permissions";
import { NextResponse, type NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { serviceInOrg } from "@/server/services/access";

/** Incremental build logs: returns text after `offset` characters. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/deployments/[deploymentId]/logs">) {
  const { deploymentId } = await ctx.params;
  const org = await requireOrg();
  if (!org.can("logs.view")) return new Response(cannotMessage("logs.view"), { status: 403 });
  const requested = Math.trunc(Number(request.nextUrl.searchParams.get("offset") ?? 0));
  // A whole number that fits the int cast below; anything else starts from the beginning.
  const offset = Number.isFinite(requested) ? Math.min(Math.max(0, requested), 2_000_000_000) : 0;
  const [row] = await db
    .select({
      serviceId: schema.deployment.serviceId,
      status: schema.deployment.status,
      error: schema.deployment.error,
      startedAt: schema.deployment.startedAt,
      finishedAt: schema.deployment.finishedAt,
      targets: schema.deployment.targets,
      registryImage: schema.deployment.registryImage,
      length: sql<number>`length(${schema.deployment.logs})`,
      chunk: sql<string>`substring(${schema.deployment.logs} from ${offset + 1}::int)`,
    })
    .from(schema.deployment)
    .where(eq(schema.deployment.id, deploymentId));
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    await serviceInOrg(row.serviceId, org.org.id);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // The log may have been truncated from the start; restart from zero.
  const reset = offset > row.length;
  return NextResponse.json({
    status: row.status,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    targets: row.targets,
    registryImage: row.registryImage,
    chunk: reset ? "" : row.chunk,
    offset: reset ? 0 : row.length,
    reset,
  });
}
