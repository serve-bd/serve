import { and, asc, eq, isNull } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";

export async function GET() {
  const ctx = await requireOrg();
  const services = await db
    .select({
      id: schema.service.id,
      name: schema.service.name,
      type: schema.service.type,
      status: schema.service.status,
      projectId: schema.project.id,
      projectName: schema.project.name,
    })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    // Pull request previews are reached through their app.
    .where(and(eq(schema.project.organizationId, ctx.org.id), isNull(schema.service.previewPr)))
    .orderBy(asc(schema.service.name));
  return Response.json({ services: services.filter((s) => ctx.canAccessProject(s.projectId)) });
}
