import { NextResponse } from "next/server";
import { requireOrg } from "@/server/auth";
import { serviceInOrg } from "@/server/services/access";
import { containerDetails } from "@/server/services/container-info";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: RouteContext<"/api/services/[serviceId]/containers/[containerId]">) {
  const { serviceId, containerId } = await ctx.params;
  const org = await requireOrg();
  let service;
  try {
    service = (await serviceInOrg(serviceId, org.org.id)).service;
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    // ?server=: a replica on one of the app's extra servers.
    const details = await containerDetails(service, containerId, new URL(req.url).searchParams.get("server"));
    if (!details) return NextResponse.json({ error: "This container is gone." }, { status: 404 });
    return NextResponse.json(details);
  } catch (e) {
    return NextResponse.json({ error: `The server is unreachable: ${(e as Error).message}` }, { status: 503 });
  }
}
