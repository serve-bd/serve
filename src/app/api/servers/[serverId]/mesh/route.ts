import { NextResponse } from "next/server";
import { meshOverview } from "@/server/mesh";
import { serverRoute } from "@/server/servers/route-auth";

export const dynamic = "force-dynamic";

/** Private network status of a server: its agent's report, links to the other servers, addresses. */
export async function GET(_request: Request, ctx: RouteContext<"/api/servers/[serverId]/mesh">) {
  const { serverId } = await ctx.params;
  const auth = await serverRoute(serverId);
  if ("error" in auth) return auth.error;
  return NextResponse.json(await meshOverview(serverId));
}
