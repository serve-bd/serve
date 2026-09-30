import { NextResponse, type NextRequest } from "next/server";
import { metricSeries, serverScope, serverSnapshot } from "@/server/metrics";
import { serverRoute } from "@/server/servers/route-auth";

export const dynamic = "force-dynamic";

/** CPU, memory and disk history of a server, plus a live snapshot. `?hours=` 1–168. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/servers/[serverId]/metrics">) {
  const { serverId } = await ctx.params;
  const auth = await serverRoute(serverId, { view: true });
  if ("error" in auth) return auth.error;
  const requested = Number(request.nextUrl.searchParams.get("hours") ?? 6);
  const hours = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 168) : 6;
  const [series, now] = await Promise.all([metricSeries(serverScope(serverId), hours), serverSnapshot(auth.server).catch(() => null)]);
  return NextResponse.json({ series, now });
}
