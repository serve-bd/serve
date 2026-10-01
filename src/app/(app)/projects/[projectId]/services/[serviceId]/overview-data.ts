import { monitorSummary } from "@/server/monitoring/queries";
import "server-only";
import { privateHost } from "@/lib/hostname";
import { and, count, desc, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getServerRow } from "@/server/servers/context";
import { publishedPorts } from "@/server/services/ports";
import { composeServiceNames } from "@/server/deploy/compose";
import { getTemplate } from "@/server/services/templates";
import { pickPrimaryDomain } from "@/lib/domains";
import { readComposeMounts } from "@/lib/compose-mounts";
import { dockerfileBase } from "@/lib/dockerfile";

type Service = typeof schema.service.$inferSelect;

/** Commit link for GitHub, GitLab and Gitea style repositories. */
function commitUrl(repository: string, sha: string) {
  const web = repository.replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "");
  if (!/^https:\/\//.test(web)) return null;
  return web.includes("gitlab") ? `${web}/-/commit/${sha}` : `${web}/commit/${sha}`;
}

export async function loadOverview(service: Service, projectId: string, orgId: string) {
  const [server, environment, deployments, domains, published, counts, stats] = await Promise.all([
    getServerRow(service.serverId),
    db.select({ name: schema.environment.name }).from(schema.environment).where(eq(schema.environment.id, service.environmentId)),
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
      .where(eq(schema.deployment.serviceId, service.id))
      .orderBy(desc(schema.deployment.createdAt))
      .limit(6),
    db.select().from(schema.domain).where(eq(schema.domain.serviceId, service.id)),
    publishedPorts(service),
    Promise.all([
      db.select({ n: count() }).from(schema.envVar).where(eq(schema.envVar.serviceId, service.id)),
      db.select({ n: count() }).from(schema.scheduledTask).where(eq(schema.scheduledTask.serviceId, service.id)),
      db.select({ n: count() }).from(schema.sharedVar).where(eq(schema.sharedVar.environmentId, service.environmentId)),
    ]),
    db
      .select({ status: schema.deployment.status, n: count() })
      .from(schema.deployment)
      .where(and(eq(schema.deployment.serviceId, service.id)))
      .groupBy(schema.deployment.status),
  ]);

  const primaryDomain = pickPrimaryDomain(domains);
  const current = deployments.find((d) => d.id === service.currentDeploymentId) ?? null;
  const latest = deployments[0] ?? null;
  const repository = service.source?.type === "git" ? service.source.repository : null;
  const finished = stats.filter((s) => s.status === "success" || s.status === "failed");
  const total = finished.reduce((a, s) => a + s.n, 0);
  const successes = stats.find((s) => s.status === "success")?.n ?? 0;
  const template = service.compose?.template ? getTemplate(service.compose.template) : null;
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  const shape = (d: (typeof deployments)[number]) => ({
    ...d,
    createdAt: d.createdAt.toISOString(),
    startedAt: iso(d.startedAt),
    finishedAt: iso(d.finishedAt),
    commitUrl: repository && d.commitSha ? commitUrl(repository, d.commitSha) : null,
  });

  const monitoring = await monitorSummary(service.id);
  return {
    monitoring,
    /** Its server records CPU and memory (the Resources charts). */
    metrics: server.metricsEnabled,
    projectId,
    orgId,
    service: {
      id: service.id,
      name: service.name,
      slug: privateHost(service),
      type: service.type as "app" | "compose",
      status: service.status,
      autoDeploy: service.autoDeploy,
      previewsEnabled: service.previewsEnabled,
      isPreview: service.previewPr !== null,
      createdAt: service.createdAt.toISOString(),
      port: service.runtime.port,
      replicas: service.runtime.replicas,
      restartPolicy: service.runtime.restartPolicy,
      cpuLimit: service.runtime.cpuLimit ?? null,
      memoryLimit: service.runtime.memoryLimit ?? null,
      /** Services in the compose file (stacks from git too, whose source is the repository). */
      composeServiceCount: service.compose ? composeServiceNames(service.compose.content).length : 0,
      volumes: service.compose ? composeMountCount(service.compose.content) : service.runtime.volumes.length,
      healthcheckPath: service.runtime.healthcheckPath ?? null,
      builder: service.build?.builder ?? null,
      rootDir: service.build?.rootDir ?? null,
      source:
        service.source?.type === "git"
          ? { kind: "git" as const, repository: service.source.repository, branch: service.source.branch }
          : service.source?.type === "image"
            ? { kind: "image" as const, image: service.source.image }
            : service.source?.type === "dockerfile"
              ? { kind: "dockerfile" as const, base: dockerfileBase(service.source.content) }
              : service.compose
                ? {
                    kind: "compose" as const,
                    template: template?.name ?? null,
                    mode: service.compose.mode,
                    path: service.compose.path,
                    services: composeServiceNames(service.compose.content),
                  }
                : null,
    },
    server: { id: server.id, name: server.name, isLocal: server.isLocal },
    environment: environment[0]?.name ?? "production",
    current: current ? shape(current) : null,
    latest: latest && latest.id !== current?.id ? shape(latest) : null,
    recent: deployments.slice(0, 5).map(shape),
    successRate: total ? successes / total : null,
    deploymentCount: stats.reduce((a, s) => a + s.n, 0),
    domains: domains
      .filter((d) => !d.redirectTo)
      .map((d) => ({
        id: d.id,
        hostname: d.hostname,
        secure: d.https || !!d.tunnelId,
        tunnel: !!d.tunnelId,
        generated: d.generated,
        primary: d === primaryDomain,
        port: d.port,
        composeService: d.composeService,
      }))
      .sort((a, b) => Number(b.primary) - Number(a.primary)),
    redirects: domains.filter((d) => d.redirectTo).length,
    published,
    counts: { variables: counts[0][0].n, tasks: counts[1][0].n, shared: counts[2][0].n },
  };
}

export type OverviewData = Awaited<ReturnType<typeof loadOverview>>;

/** Volumes, server paths and files of every service in a compose file. */
function composeMountCount(content: string) {
  try {
    return readComposeMounts(content).reduce((n, s) => n + s.mounts.filter((m) => m.kind !== "other").length, 0);
  } catch {
    return 0;
  }
}
