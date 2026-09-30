import { and, asc, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/server/db";
import type { ScopeProject } from "./editor";

/** Projects with their environments and services, for the channel's scope picker. */
export async function scopeTree(organizationId: string): Promise<ScopeProject[]> {
  const [projects, environments, services] = await Promise.all([
    db.select({ id: schema.project.id, name: schema.project.name }).from(schema.project).where(eq(schema.project.organizationId, organizationId)).orderBy(asc(schema.project.name)),
    db
      .select({ id: schema.environment.id, name: schema.environment.name, projectId: schema.environment.projectId })
      .from(schema.environment)
      .innerJoin(schema.project, eq(schema.environment.projectId, schema.project.id))
      .where(eq(schema.project.organizationId, organizationId))
      .orderBy(asc(schema.environment.createdAt)),
    db
      .select({ id: schema.service.id, name: schema.service.name, environmentId: schema.service.environmentId, projectId: schema.service.projectId })
      .from(schema.service)
      .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
      .where(and(eq(schema.project.organizationId, organizationId), isNull(schema.service.previewPr)))
      .orderBy(asc(schema.service.name)),
  ]);
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    environments: environments
      .filter((e) => e.projectId === p.id)
      .map((e) => ({ id: e.id, name: e.name, services: services.filter((s) => s.environmentId === e.id).map((s) => ({ id: s.id, name: s.name })) })),
  }));
}
