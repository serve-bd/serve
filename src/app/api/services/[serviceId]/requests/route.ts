import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { serviceInOrg } from "@/server/services/access";
import { requestSeries } from "@/server/analytics";

export async function GET(request: NextRequest, ctx: RouteContext<"/api/services/[serviceId]/requests">) {
  const { serviceId } = await ctx.params;
  const org = await requireOrg();
  try {
    await serviceInOrg(serviceId, org.org.id);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const hours = Math.min(Math.max(Number(request.nextUrl.searchParams.get("hours") ?? 24), 1), 24 * 30);
  const domains = await db.select({ hostname: schema.domain.hostname }).from(schema.domain).where(eq(schema.domain.serviceId, serviceId));
  const series = await requestSeries(domains.map((d) => d.hostname), hours);
  const totals = series.reduce(
    (acc, p) => ({ requests: acc.requests + p.requests, errors: acc.errors + p.s5xx, bytes: acc.bytes + p.bytes, ms: acc.ms + p.avgMs * p.requests }),
    { requests: 0, errors: 0, bytes: 0, ms: 0 },
  );
  return NextResponse.json({ series, totals: { ...totals, avgMs: totals.requests ? totals.ms / totals.requests : 0 } });
}
