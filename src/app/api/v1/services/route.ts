import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { apiAuth, unauthorized } from "@/server/api-auth";

export async function GET(request: Request) {
  const auth = await apiAuth(request);
  if (!auth) return unauthorized();
  const rows = await db
    .select({
      id: schema.service.id,
      name: schema.service.name,
      type: schema.service.type,
      status: schema.service.status,
      projectId: schema.project.id,
      project: schema.project.name,
      environmentId: schema.service.environmentId,
      currentDeploymentId: schema.service.currentDeploymentId,
    })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(eq(schema.project.organizationId, auth.organizationId))
    .orderBy(asc(schema.project.name), asc(schema.service.name));
  return Response.json({ services: rows });
}
