import { cannotMessage } from "@/lib/permissions";
import { NextResponse, type NextRequest } from "next/server";
import { requireOrg } from "@/server/auth";
import { serviceInOrg } from "@/server/services/access";
import { filterFromQuery, requestLogPage } from "@/server/request-log";

/** One page of the service's request log, newest first (see request-log). */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/services/[serviceId]/request-log">) {
  const { serviceId } = await ctx.params;
  const org = await requireOrg();
  if (!org.can("logs.view")) return new Response(cannotMessage("logs.view"), { status: 403 });
  try {
    await serviceInOrg(serviceId, org.org.id);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(await requestLogPage(serviceId, filterFromQuery(request.nextUrl.searchParams)));
}
