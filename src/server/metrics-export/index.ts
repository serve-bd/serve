import { and, eq, inArray, sql as dsql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LABEL } from "@/server/docker/client";
import { LOCAL_SERVER_ID, type ServerAgent } from "@/server/db/schema";
import { AGENT_FRESH_MS } from "@/server/metrics-agent";
import { AGENT_CONTAINERS_FRESH_MS } from "@/server/monitoring/containers";
import { serverScope } from "@/server/metrics";
import { buildExposition, type ExportContainer, type ExportInput, type ExportServer, REQUEST_WINDOW_MINUTES, SAMPLE_MAX_AGE_MS } from "./build";
import { cacheKey, type ExportScope, staleWhileRevalidate, ttlCache } from "./cache";

export type { ExportScope };

/*
 * GET /api/v1/metrics. Everything comes from what the worker and the servers' agents already
 * store; the only live read is the list of containers of servers whose agent does not report
 * them (the local one), shared by every scrape and organization and refreshed at most every
 * 30 seconds in the background.
 */

/** Rendered output kept per organization and token reach: Prometheus may scrape every 15 seconds from several places. */
export const OUTPUT_TTL_MS = 5_000;
const CONTAINERS_FRESH_MS = 30_000;
const CONTAINERS_MAX_AGE_MS = 5 * 60_000;
const DOCKER_TIMEOUT_MS = 5_000;

const outputCache = ttlCache<string>(OUTPUT_TTL_MS);
const containerCache = staleWhileRevalidate<ExportContainer[]>(CONTAINERS_FRESH_MS, CONTAINERS_MAX_AGE_MS);

/** The metrics text for a token's reach, cached for a few seconds. */
export function metricsText(scope: ExportScope) {
  return outputCache.get(cacheKey(scope), async () => buildExposition(await gatherExport(scope)));
}

/** For tests. */
export function clearMetricsCache() {
  outputCache.clear();
  containerCache.clear();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} seconds`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Containers of a server from Docker, with their restart counts (a few inspects at a time). */
async function dockerContainers(serverId: string): Promise<ExportContainer[]> {
  const { getServer } = await import("@/server/servers/context");
  const ctx = await getServer(serverId);
  const list = await ctx.docker.listContainers({ all: true, filters: { label: [`${LABEL.managed}=true`] } });
  const out: ExportContainer[] = [];
  const queue = list.filter((c) => c.Labels[LABEL.service]);
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const info = await ctx.docker
        .getContainer(c.Id)
        .inspect()
        .catch(() => null);
      out.push({
        serviceId: c.Labels[LABEL.service],
        serverId,
        name: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ""),
        state: info?.State.Status ?? c.State,
        restartCount: info ? (info.RestartCount ?? 0) : null,
      });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}

function agentContainers(serverId: string, agent: ServerAgent | null, now: number): ExportContainer[] | null {
  if (!agent?.containers || !agent.containersAt || agent.error) return null;
  if (now - new Date(agent.containersAt).getTime() >= AGENT_CONTAINERS_FRESH_MS) return null;
  return agent.containers.filter((c) => c.service).map((c) => ({ serviceId: c.service, serverId, name: c.name.replace(/^\//, ""), state: c.state, restartCount: c.restartCount }));
}

export async function gatherExport(scope: ExportScope, now = Date.now()): Promise<ExportInput> {
  const services = await db
    .select({
      id: schema.service.id,
      name: schema.service.name,
      slug: schema.service.slug,
      type: schema.service.type,
      status: schema.service.status,
      serverId: schema.service.serverId,
      distribution: schema.service.distribution,
      organization: schema.organization.slug,
      project: schema.project.name,
      environment: schema.environment.name,
    })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .innerJoin(schema.organization, eq(schema.project.organizationId, schema.organization.id))
    .innerJoin(schema.environment, eq(schema.service.environmentId, schema.environment.id))
    .where(
      and(eq(schema.project.organizationId, scope.organizationId), scope.projectIds ? inArray(schema.project.id, scope.projectIds.length ? scope.projectIds : [""]) : undefined),
    )
    .orderBy(schema.project.name, schema.environment.name, schema.service.name);
  const ids = services.map((s) => s.id);
  const idList = ids.join(",");

  const serverIds = new Set(services.flatMap((s) => [s.serverId, ...(s.distribution?.extraServerIds ?? [])]));
  const servers = await db
    .select({ id: schema.server.id, name: schema.server.name, isLocal: schema.server.isLocal, status: schema.server.status, agent: schema.server.agent, info: schema.server.info })
    .from(schema.server);
  const serverNames = new Map(servers.map((s) => [s.id, s.name]));

  const [samples, deployments, lastDeploy, requests, containers, hosts] = await Promise.all([
    ids.length
      ? db.execute<{ scope: string; cpu: number; memory: number; memory_limit: number | null; net_rx: number | null; net_tx: number | null; created_at: string }>(dsql`
          SELECT DISTINCT ON (scope) scope, cpu, memory, memory_limit, net_rx, net_tx, created_at
          FROM metric
          WHERE scope = ANY(string_to_array(${idList}::text, ',')) AND created_at >= now() - make_interval(secs => ${SAMPLE_MAX_AGE_MS / 1000}::int)
          ORDER BY scope, created_at DESC
        `)
      : [],
    ids.length
      ? db
          .select({ serviceId: schema.deployment.serviceId, status: schema.deployment.status, count: dsql<number>`count(*)::int` })
          .from(schema.deployment)
          .where(inArray(schema.deployment.serviceId, ids))
          .groupBy(schema.deployment.serviceId, schema.deployment.status)
      : [],
    ids.length
      ? db
          .select({ serviceId: schema.deployment.serviceId, at: dsql<string>`max(coalesce(${schema.deployment.finishedAt}, ${schema.deployment.createdAt}))` })
          .from(schema.deployment)
          .where(and(inArray(schema.deployment.serviceId, ids), eq(schema.deployment.status, "success")))
          .groupBy(schema.deployment.serviceId)
      : [],
    scope.requests ? requestCounts(ids) : null,
    Promise.all(
      servers
        .filter((s) => serverIds.has(s.id))
        .map(async (s) => {
          const reported = agentContainers(s.id, s.agent, now);
          if (reported) return reported;
          // An unreachable server is not asked: the scrape would wait for its timeout.
          if (!s.isLocal && s.status !== "ready") return [];
          return (await containerCache.get(s.id, () => withTimeout(dockerContainers(s.id), DOCKER_TIMEOUT_MS))) ?? [];
        }),
    ).then((all) => all.flat()),
    scope.hosts ? hostFigures(servers, now) : null,
  ]);

  return {
    now,
    services: services.map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      type: s.type,
      status: s.status,
      organization: s.organization,
      project: s.project,
      environment: s.environment,
      serverId: s.serverId,
    })),
    serverNames,
    samples: new Map(
      [...samples].map((r) => [
        r.scope,
        {
          cpuPercent: Number(r.cpu) / 100,
          memory: Number(r.memory),
          memoryLimit: r.memory_limit === null ? null : Number(r.memory_limit),
          netRx: r.net_rx === null ? null : Number(r.net_rx),
          netTx: r.net_tx === null ? null : Number(r.net_tx),
          at: new Date(r.created_at).getTime(),
        },
      ]),
    ),
    containers,
    requests,
    deployments: deployments.map((d) => ({ serviceId: d.serviceId, status: d.status, count: Number(d.count) })),
    lastDeploy: new Map(lastDeploy.filter((d) => d.at).map((d) => [d.serviceId, new Date(d.at).getTime()])),
    servers: hosts,
  };
}

/** Requests and 5xx answers per service over the last full minutes, from the per-minute counts of the access log. */
async function requestCounts(ids: string[]) {
  const out = new Map<string, { requests: number; s5xx: number }>();
  if (!ids.length) return out;
  const rows = await db.execute<{ service_id: string; requests: number; s5xx: number }>(dsql`
    SELECT d.service_id, sum(r.requests)::float AS requests, sum(r.s5xx)::float AS s5xx
    FROM request_metric r JOIN domain d ON d.hostname = r.hostname
    WHERE d.service_id = ANY(string_to_array(${ids.join(",")}::text, ','))
      AND r.minute >= date_trunc('minute', now()) - make_interval(mins => ${REQUEST_WINDOW_MINUTES}::int)
      AND r.minute < date_trunc('minute', now())
    GROUP BY d.service_id
  `);
  for (const r of rows) out.set(r.service_id, { requests: Number(r.requests), s5xx: Number(r.s5xx) });
  return out;
}

type ServerRow = { id: string; name: string; isLocal: boolean; status: string; agent: ServerAgent | null; info: { cpus?: number } };

/** Latest host sample of every server, plus load and cores from the agent (or this machine for the local server). */
async function hostFigures(servers: ServerRow[], now: number): Promise<ExportServer[]> {
  const scopes = servers.map((s) => serverScope(s.id));
  const rows = scopes.length
    ? await db.execute<{ scope: string; cpu: number; memory: number; memory_limit: number | null; disk: number | null; disk_total: number | null }>(dsql`
        SELECT DISTINCT ON (scope) scope, cpu, memory, memory_limit, disk, disk_total
        FROM metric
        WHERE scope = ANY(string_to_array(${scopes.join(",")}::text, ',')) AND created_at >= now() - make_interval(secs => ${SAMPLE_MAX_AGE_MS / 1000}::int)
        ORDER BY scope, created_at DESC
      `)
    : [];
  const byScope = new Map([...rows].map((r) => [r.scope, r]));
  const os = await import("node:os");
  return servers.map((s) => {
    const r = byScope.get(serverScope(s.id));
    const snap = s.agent?.snapshot;
    const agentFresh = !!snap && now - new Date(snap.at).getTime() < AGENT_FRESH_MS;
    const local = s.id === LOCAL_SERVER_ID || s.isLocal;
    return {
      id: s.id,
      name: s.name,
      reachable: local || s.status === "ready",
      cpuPercent: r ? Number(r.cpu) / 100 : null,
      cores: local ? os.cpus().length : agentFresh ? snap.cores : (s.info.cpus ?? null),
      memoryUsed: r ? Number(r.memory) : null,
      memoryTotal: r?.memory_limit != null ? Number(r.memory_limit) : null,
      diskUsed: r?.disk != null ? Number(r.disk) : null,
      diskTotal: r?.disk_total != null ? Number(r.disk_total) : null,
      load: local ? os.loadavg() : agentFresh ? snap.load : null,
    };
  });
}
