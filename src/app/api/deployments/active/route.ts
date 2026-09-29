import { NextResponse } from "next/server";
import { requireOrg } from "@/server/auth";
import { liveDeployments } from "@/server/queries";

export const dynamic = "force-dynamic";

/** Running and just-finished deployments of the organization, for the floating indicator. */
export async function GET() {
  const ctx = await requireOrg();
  if (!ctx.can("projects.view")) return NextResponse.json({ deployments: [] });
  const rows = await liveDeployments(ctx.org.id, ctx.projectIds);
  return NextResponse.json({ deployments: rows });
}
