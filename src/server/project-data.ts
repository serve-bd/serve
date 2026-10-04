import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { shownServiceStatus } from "@/lib/server-services";
import { db, schema } from "@/server/db";
import { pickPrimaryDomain } from "@/lib/domains";
import { type ServiceIssue, serviceIssues } from "@/server/services/issues";
import { type ServiceUse, serviceUses } from "@/server/services/uses";
import { decryptOrNull } from "@/server/crypto";
import { meshMemberIds, reachesPrivately } from "@/server/mesh/members";
import { scopeReader } from "@/lib/refs";
import { runServerIds } from "@/server/deploy/distribution";

export type { ServiceUse };

export type ServiceCardData = {
  id: string;
  name: string;
  type: string;
  icon: string | null;
  status: string;
  engine: string | null;
  source: string | null;
  domain: string | null;
  domainHttps: boolean;
  lastDeploy: { id: string; status: string; commitMessage: string | null; createdAt: Date } | null;
  /** Problems that need attention, worst first. */
  issues: ServiceIssue[];
  serverId: string;
  serverName: string;
  /** Services of the environment this one references in its variables. */
  uses: ServiceUse[];
};

export async function environmentServices(environmentId: string): Promise<ServiceCardData[]> {
  // Previews and their database copies belong to their app: listed on its Previews tab, not as cards.
  const services = await db
    .select()
    .from(schema.service)
    .where(and(eq(schema.service.environmentId, environmentId), isNull(schema.service.previewPr)))
    .orderBy(asc(schema.service.createdAt));
  if (!services.length) return [];
  const ids = services.map((s) => s.id);
  const [domains, deployments, issues, vars, servers, mesh, [scopeRow]] = await Promise.all([
    db.select().from(schema.domain).where(inArray(schema.domain.serviceId, ids)).orderBy(asc(schema.domain.createdAt)),
    db
      .selectDistinctOn([schema.deployment.serviceId], {
        id: schema.deployment.id,
        serviceId: schema.deployment.serviceId,
        status: schema.deployment.status,
        commitMessage: schema.deployment.commitMessage,
        createdAt: schema.deployment.createdAt,
      })
      .from(schema.deployment)
      .where(inArray(schema.deployment.serviceId, ids))
      .orderBy(schema.deployment.serviceId, desc(schema.deployment.createdAt)),
    serviceIssues(ids),
    // Literal values reference nothing: their ${{…}} is text.
    db
      .select({ serviceId: schema.envVar.serviceId, key: schema.envVar.key, value: schema.envVar.value })
      .from(schema.envVar)
      .where(and(inArray(schema.envVar.serviceId, ids), eq(schema.envVar.literal, false))),
    db
      .select({ id: schema.server.id, name: schema.server.name, status: schema.server.status, isLocal: schema.server.isLocal })
      .from(schema.server)
      .where(
        inArray(
          schema.server.id,
          services.map((s) => s.serverId),
        ),
      ),
    meshMemberIds(),
    db
      .select({ projectId: schema.project.id, organizationId: schema.project.organizationId })
      .from(schema.environment)
      .innerJoin(schema.project, eq(schema.environment.projectId, schema.project.id))
      .where(eq(schema.environment.id, environmentId)),
  ]);
  // Shared variables, for references that go through them (like variable resolution does).
  const shared = scopeRow
    ? await db
        .select()
        .from(schema.sharedVar)
        .where(
          or(
            eq(schema.sharedVar.environmentId, environmentId),
            and(isNull(schema.sharedVar.environmentId), eq(schema.sharedVar.projectId, scopeRow.projectId)),
            and(isNull(schema.sharedVar.environmentId), isNull(schema.sharedVar.projectId), eq(schema.sharedVar.organizationId, scopeRow.organizationId)),
          ),
        )
    : [];
  const mapOf = (pick: (v: (typeof shared)[number]) => boolean) => Object.fromEntries(shared.filter(pick).map((v) => [v.key, decryptOrNull(v.value) ?? ""]));
  const runsOn = new Map(services.map((s) => [s.id, runServerIds(s.serverId, s.type === "app" ? s.distribution : null)]));
  const uses = serviceUses(
    services,
    vars.map((v) => ({ ...v, value: decryptOrNull(v.value) ?? "" })),
    scopeReader({ environment: mapOf((v) => !!v.environmentId), project: mapOf((v) => !v.environmentId && !!v.projectId), org: mapOf((v) => !v.environmentId && !v.projectId) }),
    (consumer, provider) => reachesPrivately(mesh, runsOn.get(consumer.id)!, { serverId: provider.serverId, servers: runsOn.get(provider.id)! }),
  );
  return services.map((s) => {
    const primary = pickPrimaryDomain(domains.filter((x) => x.serviceId === s.id));
    const dep = deployments.find((x) => x.serviceId === s.id);
    return {
      id: s.id,
      name: s.name,
      type: s.type,
      icon: s.icon,
      status: shownServiceStatus(
        s.status,
        servers.find((x) => x.id === s.serverId),
      ),
      engine: s.database?.engine ?? null,
      source:
        s.source?.type === "git"
          ? s.source.repository.replace(/^https?:\/\/(www\.)?/, "").replace(/\.git$/, "")
          : s.source?.type === "image"
            ? s.source.image
            : s.source?.type === "dockerfile"
              ? "Dockerfile"
              : s.compose?.template
                ? `Template · ${s.compose.template}`
                : s.type === "compose"
                  ? "Docker Compose"
                  : null,
      domain: primary?.hostname ?? null,
      domainHttps: primary?.https ?? false,
      lastDeploy: dep ? { id: dep.id, status: dep.status, commitMessage: dep.commitMessage, createdAt: dep.createdAt } : null,
      issues: issues.get(s.id) ?? [],
      serverId: s.serverId,
      serverName: servers.find((x) => x.id === s.serverId)?.name ?? "",
      uses: uses.get(s.id) ?? [],
    };
  });
}

export async function projectEnvironments(projectId: string) {
  return db.select().from(schema.environment).where(eq(schema.environment.projectId, projectId)).orderBy(asc(schema.environment.createdAt));
}

export async function resolveEnvironment(projectId: string, name: string | undefined) {
  const envs = await projectEnvironments(projectId);
  const current = envs.find((e) => e.name === name) ?? envs.find((e) => e.name === "production") ?? envs[0];
  return { envs, current };
}

export async function envBelongs(projectId: string, environmentId: string) {
  const [env] = await db
    .select()
    .from(schema.environment)
    .where(and(eq(schema.environment.id, environmentId), eq(schema.environment.projectId, projectId)));
  return env ?? null;
}
