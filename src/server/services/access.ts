import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db, schema } from "@/server/db";
import { UserError } from "@/server/action";

/**
 * Whether the signed-in member may reach this project. Requests without a session
 * (API tokens, the worker) check access themselves, so they always pass here.
 */
async function projectAllowed(projectId: string, orgId: string) {
  const { sessionOrgContext } = await import("@/server/auth");
  const ctx = await sessionOrgContext();
  return !ctx || ctx.org.id !== orgId || ctx.canAccessProject(projectId);
}

/** Load a service only if it belongs to the organization (and the member may reach its project). */
export async function serviceInOrg(serviceId: string, orgId: string) {
  const [row] = await db
    .select({ service: schema.service, project: schema.project })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(and(eq(schema.service.id, serviceId), eq(schema.project.organizationId, orgId)));
  if (!row || !(await projectAllowed(row.project.id, orgId))) throw new UserError("Service not found.");
  return row;
}

export async function projectInOrg(projectId: string, orgId: string) {
  const [project] = await db
    .select()
    .from(schema.project)
    .where(and(eq(schema.project.id, projectId), eq(schema.project.organizationId, orgId)));
  if (!project || !(await projectAllowed(project.id, orgId))) throw new UserError("Project not found.");
  return project;
}

/** For pages: 404 instead of throwing. */
export async function pageService(serviceId: string, projectId: string, orgId: string) {
  const [row] = await db
    .select({ service: schema.service, project: schema.project })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(and(eq(schema.service.id, serviceId), eq(schema.project.id, projectId), eq(schema.project.organizationId, orgId)));
  if (!row || !(await projectAllowed(row.project.id, orgId))) notFound();
  return row;
}

export async function pageProject(projectId: string, orgId: string) {
  const [project] = await db
    .select()
    .from(schema.project)
    .where(and(eq(schema.project.id, projectId), eq(schema.project.organizationId, orgId)));
  if (!project || !(await projectAllowed(project.id, orgId))) notFound();
  return project;
}
