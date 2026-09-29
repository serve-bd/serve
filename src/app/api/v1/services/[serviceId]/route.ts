import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { notFound, requireToken, tokenService } from "@/server/api-auth";

/** One service with its domains and variable names. Values need read:sensitive. Scope: read. */
export async function GET(request: Request, ctx: RouteContext<"/api/v1/services/[serviceId]">) {
  const { auth, error } = await requireToken(request, "read");
  if (error) return error;
  const { serviceId } = await ctx.params;
  const row = await tokenService(auth, serviceId);
  if (!row) return notFound("Service not found");
  const { service, project } = row;
  const [domains, vars] = await Promise.all([
    db.select({ hostname: schema.domain.hostname, https: schema.domain.https }).from(schema.domain).where(eq(schema.domain.serviceId, service.id)),
    db.select({ key: schema.envVar.key }).from(schema.envVar).where(eq(schema.envVar.serviceId, service.id)).orderBy(asc(schema.envVar.key)),
  ]);
  return Response.json({
    service: {
      id: service.id,
      name: service.name,
      type: service.type,
      status: service.status,
      projectId: project.id,
      project: project.name,
      environmentId: service.environmentId,
      currentDeploymentId: service.currentDeploymentId,
      domains: domains.map((d) => `${d.https ? "https" : "http"}://${d.hostname}`),
      variables: vars.map((v) => v.key),
      createdAt: service.createdAt,
    },
  });
}
