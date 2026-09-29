import { NextResponse, type NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { latestServiceSamples } from "@/server/metrics";
import { serverRoute } from "@/server/servers/route-auth";

export const dynamic = "force-dynamic";

/** Services on a server ranked by their latest CPU and memory samples. */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/servers/[serverId]/metrics/top">) {
  const { serverId } = await ctx.params;
  const auth = await serverRoute(serverId);
  if ("error" in auth) return auth.error;
  const samples = await latestServiceSamples();
  if (!samples.length) return NextResponse.json({ services: [] });
  const rows = await db
    .select({
      id: schema.service.id,
      name: schema.service.name,
      type: schema.service.type,
      projectId: schema.project.id,
      projectName: schema.project.name,
      organizationName: schema.organization.name,
    })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .innerJoin(schema.organization, eq(schema.project.organizationId, schema.organization.id))
    .where(
      and(
        inArray(
          schema.service.id,
          samples.map((s) => s.serviceId),
        ),
        eq(schema.service.serverId, serverId),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const services = samples.filter((s) => byId.has(s.serviceId)).map((s) => ({ ...byId.get(s.serviceId)!, cpu: s.cpu, memory: s.memory, memoryLimit: s.memoryLimit }));
  return NextResponse.json({ services });
}
