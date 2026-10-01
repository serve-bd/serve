import { and, eq, inArray, type SQL } from "drizzle-orm";
import { db, schema } from "@/server/db";
import type { ApiAuth } from "@/server/api-auth";
import { ApiError } from "./router";

/*
 * What the API shows of each record: the fields people need, never stored secrets (passwords,
 * tokens, webhook secrets, encrypted values). Values of variables need variables.view-secrets.
 */

type Service = typeof schema.service.$inferSelect;
type Project = typeof schema.project.$inferSelect;
type Deployment = typeof schema.deployment.$inferSelect;
type Domain = typeof schema.domain.$inferSelect;
type Server = typeof schema.server.$inferSelect;

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Projects the token may reach, as a filter on project.id. */
export function projectFilter(auth: ApiAuth): SQL | undefined {
  return auth.projectIds ? inArray(schema.project.id, auth.projectIds.length ? auth.projectIds : ["-"]) : undefined;
}

export async function loadProject(auth: ApiAuth, projectId: string): Promise<Project> {
  const [project] = await db
    .select()
    .from(schema.project)
    .where(and(eq(schema.project.id, projectId), eq(schema.project.organizationId, auth.organizationId)));
  if (!project || !auth.canAccessProject(project.id)) throw new ApiError(404, "Project not found");
  return project;
}

export async function loadEnvironment(auth: ApiAuth, environmentId: string) {
  const [row] = await db
    .select({ environment: schema.environment, project: schema.project })
    .from(schema.environment)
    .innerJoin(schema.project, eq(schema.environment.projectId, schema.project.id))
    .where(and(eq(schema.environment.id, environmentId), eq(schema.project.organizationId, auth.organizationId)));
  if (!row || !auth.canAccessProject(row.project.id)) throw new ApiError(404, "Environment not found");
  return row;
}

export async function loadService(auth: ApiAuth, serviceId: string): Promise<{ service: Service; project: Project }> {
  const [row] = await db
    .select({ service: schema.service, project: schema.project })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(and(eq(schema.service.id, serviceId), eq(schema.project.organizationId, auth.organizationId)));
  if (!row || !auth.canAccessProject(row.project.id)) throw new ApiError(404, "Service not found");
  return row;
}

export async function loadDeployment(auth: ApiAuth, deploymentId: string) {
  const [d] = await db.select().from(schema.deployment).where(eq(schema.deployment.id, deploymentId));
  if (!d) throw new ApiError(404, "Deployment not found");
  const { service } = await loadService(auth, d.serviceId).catch(() => {
    throw new ApiError(404, "Deployment not found");
  });
  return { deployment: d, service };
}

export async function loadDomain(auth: ApiAuth, domainId: string) {
  const [d] = await db.select().from(schema.domain).where(eq(schema.domain.id, domainId));
  if (!d) throw new ApiError(404, "Domain not found");
  await loadService(auth, d.serviceId).catch(() => {
    throw new ApiError(404, "Domain not found");
  });
  return d;
}

export function projectView(p: Project) {
  return { id: p.id, name: p.name, description: p.description, color: p.color, createdAt: iso(p.createdAt), updatedAt: iso(p.updatedAt) };
}

export function environmentView(e: typeof schema.environment.$inferSelect) {
  return { id: e.id, projectId: e.projectId, name: e.name, createdAt: iso(e.createdAt) };
}

export function serviceView(s: Service, project?: Pick<Project, "id" | "name">) {
  const source = s.source ? { ...s.source, registryPassword: undefined } : null;
  const database = s.database
    ? {
        engine: s.database.engine,
        version: s.database.version,
        image: s.database.image ?? null,
        username: s.database.username,
        database: s.database.database,
        publicPort: s.database.publicPort ?? null,
        publicBind: s.database.publicBind ?? null,
        publicAllow: s.database.publicAllow ?? null,
        tls: s.database.tls ?? null,
        domain: s.database.domain ?? null,
        backupSchedule: s.database.backupSchedule ?? null,
        backupRetention: s.database.backupRetention,
      }
    : null;
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    type: s.type,
    status: s.status,
    projectId: s.projectId,
    project: project?.name,
    environmentId: s.environmentId,
    serverId: s.serverId,
    hostname: s.hostname,
    icon: s.icon,
    source,
    build: s.build,
    runtime: s.runtime,
    database,
    compose: s.compose ? { mode: s.compose.mode, path: s.compose.path ?? null, template: s.compose.template ?? null } : null,
    distribution: s.distribution,
    autoDeploy: s.autoDeploy,
    previewsEnabled: s.previewsEnabled,
    previewDomain: s.previewDomain,
    parentServiceId: s.parentServiceId,
    previewPr: s.previewPr,
    maintenance: s.maintenance,
    currentDeploymentId: s.currentDeploymentId,
    createdAt: iso(s.createdAt),
    updatedAt: iso(s.updatedAt),
  };
}

export function deploymentView(d: Deployment, opts: { logTail?: boolean } = {}) {
  return {
    id: d.id,
    serviceId: d.serviceId,
    status: d.status,
    trigger: d.trigger,
    image: d.image,
    commitSha: d.commitSha,
    commitMessage: d.commitMessage,
    commitAuthor: d.commitAuthor,
    branch: d.branch,
    rollbackOf: d.rollbackOf,
    targets: d.targets,
    error: d.error,
    createdBy: d.createdBy,
    createdAt: iso(d.createdAt),
    startedAt: iso(d.startedAt),
    finishedAt: iso(d.finishedAt),
    ...(opts.logTail ? { logTail: d.logs.slice(-4000) } : {}),
  };
}

export function domainView(d: Domain) {
  return {
    id: d.id,
    serviceId: d.serviceId,
    hostname: d.hostname,
    url: `${d.https || d.tunnelId ? "https" : "http"}://${d.hostname}`,
    port: d.port,
    composeService: d.composeService,
    pathPrefix: d.pathPrefix,
    https: d.https,
    forceHttps: d.forceHttps,
    redirectTo: d.redirectTo,
    certificateId: d.certificateId,
    tunnelId: d.tunnelId,
    generated: d.generated,
    primary: d.primary,
    cloudflare: d.cloudflareZoneId ? { accountId: d.cloudflareAccountId, zoneId: d.cloudflareZoneId, recordId: d.cloudflareRecordId } : null,
    createdAt: iso(d.createdAt),
  };
}

export function serverView(s: Server) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    isLocal: s.isLocal,
    host: s.host,
    port: s.port,
    username: s.username,
    status: s.status,
    statusMessage: s.statusMessage,
    publicIp: s.publicIp,
    wildcardDomain: s.wildcardDomain,
    proxyKind: s.proxyKind,
    proxyHttpPort: s.proxyHttpPort,
    proxyHttpsPort: s.proxyHttpsPort,
    proxyStopped: s.proxyStopped,
    buildConcurrency: s.buildConcurrency,
    metricsEnabled: s.metricsEnabled,
    metricsRetentionHours: s.metricsRetentionHours,
    info: s.info,
    lastSeenAt: iso(s.lastSeenAt),
    createdAt: iso(s.createdAt),
  };
}

/** Servers this organization may use: its own, and shared ones it was given. */
export async function orgServers(organizationId: string) {
  const { serverAllowsOrg } = await import("@/server/servers/access");
  const rows = await db.select().from(schema.server);
  return rows.filter((s) => serverAllowsOrg(s, organizationId));
}

export async function loadServer(auth: ApiAuth, serverId: string) {
  const server = (await orgServers(auth.organizationId)).find((s) => s.id === serverId);
  if (!server) throw new ApiError(404, "Server not found");
  return server;
}

/** Pagination: ?limit (1-200, default 50) and ?offset. */
export const page = (q: { limit?: number; offset?: number } | undefined) => ({ limit: Math.min(Math.max(q?.limit ?? 50, 1), 200), offset: Math.max(q?.offset ?? 0, 0) });
