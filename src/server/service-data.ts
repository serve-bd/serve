import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { listServiceContainers, LABEL } from "@/server/docker/client";
import { getServerRow, serverOf } from "@/server/servers/context";
import { shownServiceStatus } from "@/lib/server-services";

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
    serverOf(service)
      .then((server) => listServiceContainers(serviceId, true, server.docker))
      .catch(() => []),
  ]);
  const previews = await previewsLive(service);
  return {
    previews,
    status: shownServiceStatus(service.status, await getServerRow(service.serverId).catch(() => null)),
    currentDeploymentId: service.currentDeploymentId,
    domains: domains.map((d) => ({
      id: d.id,
      hostname: d.hostname,
      https: d.https || !!d.tunnelId,
      redirectTo: d.redirectTo,
      generated: d.generated,
      primary: d.primary,
      createdAt: d.createdAt.toISOString(),
    })),
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

/**
 * An app's open pull request previews: their deployments and containers are shown with the app's
 * own (marked with the pull request), apart from its replicas and its current deployment.
 */
async function previewsLive(service: typeof schema.service.$inferSelect) {
  if (service.type !== "app" || service.parentServiceId) return [];
  const previews = await db
    .select()
    .from(schema.service)
    .where(and(eq(schema.service.parentServiceId, service.id), eq(schema.service.type, "app"), isNotNull(schema.service.previewPr)))
    .orderBy(desc(schema.service.previewPr));
  if (!previews.length) return [];
  const ids = previews.map((p) => p.id);
  const deployments = await db
    .select({
      id: schema.deployment.id,
      serviceId: schema.deployment.serviceId,
      status: schema.deployment.status,
      trigger: schema.deployment.trigger,
      commitSha: schema.deployment.commitSha,
      commitMessage: schema.deployment.commitMessage,
      commitAuthor: schema.deployment.commitAuthor,
      branch: schema.deployment.branch,
      createdAt: schema.deployment.createdAt,
      startedAt: schema.deployment.startedAt,
      finishedAt: schema.deployment.finishedAt,
    })
    .from(schema.deployment)
    .where(inArray(schema.deployment.serviceId, ids))
    .orderBy(desc(schema.deployment.createdAt))
    .limit(30);
  return Promise.all(
    previews.map(async (p) => ({
      id: p.id,
      pr: p.previewPr!,
      status: p.status,
      currentDeploymentId: p.currentDeploymentId,
      deployments: deployments.filter((d) => d.serviceId === p.id),
      containers: await serverOf(p)
        .then((server) => listServiceContainers(p.id, true, server.docker))
        .then((list) =>
          list.map((c) => ({
            id: c.Id.slice(0, 12),
            name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
            state: c.State,
            status: c.Status,
            deployment: c.Labels[LABEL.deployment] ?? null,
          })),
        )
        .catch(() => []),
    })),
  );
}
