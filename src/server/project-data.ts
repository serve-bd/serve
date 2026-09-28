import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";

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
};

export async function environmentServices(environmentId: string): Promise<ServiceCardData[]> {
  const services = await db
    .select()
    .from(schema.service)
    .where(eq(schema.service.environmentId, environmentId))
    .orderBy(asc(schema.service.createdAt));
  if (!services.length) return [];
  const ids = services.map((s) => s.id);
  const [domains, deployments] = await Promise.all([
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
  ]);
  return services.map((s) => {
    const d = domains.filter((x) => x.serviceId === s.id && !x.redirectTo);
    const primary = d.find((x) => !x.generated) ?? d[0];
    const dep = deployments.find((x) => x.serviceId === s.id);
    return {
      id: s.id,
      name: s.name,
      type: s.type,
      icon: s.icon,
      status: s.status,
      engine: s.database?.engine ?? null,
      source:
        s.source?.type === "git"
          ? s.source.repository.replace(/^https?:\/\/(www\.)?/, "").replace(/\.git$/, "")
          : s.source?.type === "image"
            ? s.source.image
            : s.compose?.template
              ? `Template · ${s.compose.template}`
              : s.type === "compose"
                ? "Docker Compose"
                : null,
      domain: primary?.hostname ?? null,
      domainHttps: primary?.https ?? false,
      lastDeploy: dep ? { id: dep.id, status: dep.status, commitMessage: dep.commitMessage, createdAt: dep.createdAt } : null,
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
