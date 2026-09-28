import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db, schema } from "@/server/db";
import { UserError } from "@/server/action";

/** Load a service only if it belongs to the organization. */
export async function serviceInOrg(serviceId: string, orgId: string) {
  const [row] = await db
    .select({ service: schema.service, project: schema.project })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(and(eq(schema.service.id, serviceId), eq(schema.project.organizationId, orgId)));
  if (!row) throw new UserError("Service not found.");
  return row;
}

export async function projectInOrg(projectId: string, orgId: string) {
  const [project] = await db
    .select()
    .from(schema.project)
    .where(and(eq(schema.project.id, projectId), eq(schema.project.organizationId, orgId)));
  if (!project) throw new UserError("Project not found.");
  return project;
}

/** For pages: 404 instead of throwing. */
export async function pageService(serviceId: string, projectId: string, orgId: string) {
  const [row] = await db
    .select({ service: schema.service, project: schema.project })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(and(eq(schema.service.id, serviceId), eq(schema.project.id, projectId), eq(schema.project.organizationId, orgId)));
  if (!row) notFound();
  return row;
}

export async function pageProject(projectId: string, orgId: string) {
  const [project] = await db
    .select()
    .from(schema.project)
    .where(and(eq(schema.project.id, projectId), eq(schema.project.organizationId, orgId)));
  if (!project) notFound();
  return project;
}
