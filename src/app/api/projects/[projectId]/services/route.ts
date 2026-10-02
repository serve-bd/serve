import { NextResponse, type NextRequest } from "next/server";
import { requireOrg } from "@/server/auth";
import { projectInOrg } from "@/server/services/access";
import { envBelongs, environmentServices } from "@/server/project-data";

export async function GET(request: NextRequest, ctx: RouteContext<"/api/projects/[projectId]/services">) {
  const { projectId } = await ctx.params;
  const org = await requireOrg();
  if (!org.can("projects.view")) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    await projectInOrg(projectId, org.org.id);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const envId = request.nextUrl.searchParams.get("env") ?? "";
  if (!(await envBelongs(projectId, envId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ services: await environmentServices(envId) });
}
