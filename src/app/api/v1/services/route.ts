import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { requireToken } from "@/server/api-auth";

/** Services in the token's organization (and allowed projects). Scope: read. */
export async function GET(request: Request) {
  const { auth, error } = await requireToken(request, "read");
  if (error) return error;
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
    .where(
      and(
        eq(schema.project.organizationId, auth.organizationId),
        auth.projectIds ? inArray(schema.project.id, auth.projectIds) : undefined,
      ),
    )
    .orderBy(asc(schema.project.name), asc(schema.service.name));
  return Response.json({ services: rows });
}
