import { NextResponse } from "next/server";
import { requireOrg } from "@/server/auth";
import { serviceInOrg } from "@/server/services/access";
import { serviceLive } from "@/server/service-data";

export async function GET(_req: Request, ctx: RouteContext<"/api/services/[serviceId]/live">) {
  const { serviceId } = await ctx.params;
  const org = await requireOrg();
  try {
    await serviceInOrg(serviceId, org.org.id);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(await serviceLive(serviceId));
}
