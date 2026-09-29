import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { db, schema } from "@/server/db";
import type { ProjectSummary } from "@/app/(app)/_components/project-card";

/** `projectIds` limits the result to the projects a member can reach (null: all). */
export async function projectSummaries(orgId: string, projectIds: string[] | null = null): Promise<ProjectSummary[]> {
  if (projectIds && !projectIds.length) return [];
  const projects = await db
    .select()
    .from(schema.project)
    .where(and(eq(schema.project.organizationId, orgId), projectIds ? inArray(schema.project.id, projectIds) : undefined))
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
    .where(
      inArray(
        schema.service.projectId,
        projects.map((p) => p.id),
      ),
    );
  return projects.map((p) => {
    const own = services.filter((s) => s.projectId === p.id);
    const latest = own.reduce((acc, s) => (s.updatedAt > acc ? s.updatedAt : acc), p.updatedAt);
    return { id: p.id, name: p.name, description: p.description, color: p.color, updatedAt: latest, services: own };
  });
}

export async function recentDeployments(orgId: string, limit = 8, projectId?: string, projectIds: string[] | null = null) {
  if (projectIds && !projectIds.length) return [];
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
      environmentName: schema.environment.name,
      serverId: schema.server.id,
      serverName: schema.server.name,
    })
    .from(schema.deployment)
    .innerJoin(schema.service, eq(schema.deployment.serviceId, schema.service.id))
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .leftJoin(schema.environment, eq(schema.service.environmentId, schema.environment.id))
    .leftJoin(schema.server, eq(schema.service.serverId, schema.server.id))
    .where(and(eq(schema.project.organizationId, orgId), projectId ? eq(schema.project.id, projectId) : undefined, projectIds ? inArray(schema.project.id, projectIds) : undefined))
    .orderBy(desc(schema.deployment.createdAt))
    .limit(limit);
}

/** With `projectIds`, only entries of those projects (and organization-wide ones). */
export async function recentActivity(orgId: string, limit = 12, projectIds: string[] | null = null) {
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
    .where(
      and(
        eq(schema.activity.organizationId, orgId),
        projectIds ? or(isNull(schema.activity.projectId), projectIds.length ? inArray(schema.activity.projectId, projectIds) : undefined) : undefined,
      ),
    )
    .orderBy(desc(schema.activity.createdAt))
    .limit(limit);
}

/**
 * Deployments running now, plus the ones that finished in the last `recentSeconds`, for the
 * floating indicator. `projectIds` limits them to the projects a member can reach.
 */
export async function liveDeployments(orgId: string, projectIds: string[] | null = null, recentSeconds = 20) {
  if (projectIds && !projectIds.length) return [];
  return db
    .select({
      id: schema.deployment.id,
      status: schema.deployment.status,
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
    .where(
      and(
        eq(schema.project.organizationId, orgId),
        projectIds ? inArray(schema.project.id, projectIds) : undefined,
        or(inArray(schema.deployment.status, ["queued", "building", "deploying"]), gt(schema.deployment.finishedAt, new Date(Date.now() - recentSeconds * 1000))),
      ),
    )
    .orderBy(desc(schema.deployment.createdAt))
    .limit(20);
}
