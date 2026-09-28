import { asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { listServiceContainers, LABEL } from "@/server/docker/client";

export type ServiceLive = Awaited<ReturnType<typeof serviceLive>>;

export async function serviceLive(serviceId: string) {
  const [service] = await db.select().from(schema.service).where(eq(schema.service.id, serviceId));
  const [domains, deployments, containers] = await Promise.all([
    db.select().from(schema.domain).where(eq(schema.domain.serviceId, serviceId)).orderBy(asc(schema.domain.createdAt)),
    db
      .select({
        id: schema.deployment.id,
        status: schema.deployment.status,
        trigger: schema.deployment.trigger,
        commitSha: schema.deployment.commitSha,
        commitMessage: schema.deployment.commitMessage,
        commitAuthor: schema.deployment.commitAuthor,
        branch: schema.deployment.branch,
        image: schema.deployment.image,
        error: schema.deployment.error,
        createdAt: schema.deployment.createdAt,
        startedAt: schema.deployment.startedAt,
        finishedAt: schema.deployment.finishedAt,
        userName: schema.user.name,
      })
      .from(schema.deployment)
      .leftJoin(schema.user, eq(schema.deployment.createdBy, schema.user.id))
      .where(eq(schema.deployment.serviceId, serviceId))
      .orderBy(desc(schema.deployment.createdAt))
      .limit(30),
    listServiceContainers(serviceId).catch(() => []),
  ]);
  return {
    status: service.status,
    currentDeploymentId: service.currentDeploymentId,
    domains: domains.map((d) => ({ id: d.id, hostname: d.hostname, https: d.https, redirectTo: d.redirectTo, generated: d.generated })),
    deployments,
    containers: containers.map((c) => ({
      id: c.Id.slice(0, 12),
      name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
      state: c.State,
      status: c.Status,
      image: c.Image,
      deployment: c.Labels[LABEL.deployment] ?? null,
      composeService: c.Labels["com.docker.compose.service"] ?? null,
    })),
  };
}
