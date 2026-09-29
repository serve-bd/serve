import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { latestServiceSamples } from "@/server/metrics";

export const dynamic = "force-dynamic";

/** Services on this server ranked by their latest CPU and memory samples. */
export async function GET() {
  const ctx = await requireOrg();
  if (!ctx.isInstanceAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
    .where(inArray(schema.service.id, samples.map((s) => s.serviceId)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const services = samples
    .filter((s) => byId.has(s.serviceId))
    .map((s) => ({ ...byId.get(s.serviceId)!, cpu: s.cpu, memory: s.memory, memoryLimit: s.memoryLimit }));
  return NextResponse.json({ services });
}
