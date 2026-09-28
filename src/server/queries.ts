import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import type { ProjectSummary } from "@/app/(app)/_components/project-card";

export async function projectSummaries(orgId: string): Promise<ProjectSummary[]> {
  const projects = await db
    .select()
    .from(schema.project)
    .where(eq(schema.project.organizationId, orgId))
    .orderBy(desc(schema.project.updatedAt));
  if (!projects.length) return [];
  const services = await db
    .select({
      id: schema.service.id,
      name: schema.service.name,
      type: schema.service.type,
      status: schema.service.status,
      projectId: schema.service.projectId,
      updatedAt: schema.service.updatedAt,
    })
    .from(schema.service)
    .where(inArray(schema.service.projectId, projects.map((p) => p.id)));
  return projects.map((p) => {
    const own = services.filter((s) => s.projectId === p.id);
    const latest = own.reduce((acc, s) => (s.updatedAt > acc ? s.updatedAt : acc), p.updatedAt);
    return { id: p.id, name: p.name, description: p.description, color: p.color, updatedAt: latest, services: own };
  });
}

export async function recentDeployments(orgId: string, limit = 8, projectId?: string) {
  return db
    .select({
      id: schema.deployment.id,
      status: schema.deployment.status,
      trigger: schema.deployment.trigger,
      commitSha: schema.deployment.commitSha,
      commitMessage: schema.deployment.commitMessage,
      branch: schema.deployment.branch,
      createdAt: schema.deployment.createdAt,
      startedAt: schema.deployment.startedAt,
      finishedAt: schema.deployment.finishedAt,
      serviceId: schema.service.id,
      serviceName: schema.service.name,
      projectId: schema.project.id,
      projectName: schema.project.name,
    })
    .from(schema.deployment)
    .innerJoin(schema.service, eq(schema.deployment.serviceId, schema.service.id))
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(and(eq(schema.project.organizationId, orgId), projectId ? eq(schema.project.id, projectId) : undefined))
    .orderBy(desc(schema.deployment.createdAt))
    .limit(limit);
}

export async function recentActivity(orgId: string, limit = 12) {
  return db
    .select({
      id: schema.activity.id,
      action: schema.activity.action,
      message: schema.activity.message,
      createdAt: schema.activity.createdAt,
      projectId: schema.activity.projectId,
      targetId: schema.activity.targetId,
      targetType: schema.activity.targetType,
      userName: schema.user.name,
    })
    .from(schema.activity)
    .leftJoin(schema.user, eq(schema.activity.userId, schema.user.id))
    .where(eq(schema.activity.organizationId, orgId))
    .orderBy(desc(schema.activity.createdAt))
    .limit(limit);
}
