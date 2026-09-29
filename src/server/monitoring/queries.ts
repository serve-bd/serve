import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { dailyBars, type DayBar, uptimePercent } from "./state";

export type MonitorSummary = {
  monitor: {
    enabled: boolean;
    kind: "http" | "container";
    status: "pending" | "up" | "down" | "paused";
    url: string | null;
    path: string;
    expectedStatus: string;
    keyword: string | null;
    intervalSeconds: number;
    timeoutMs: number;
    failureThreshold: number;
    lastCheckedAt: string | null;
    lastLatencyMs: number | null;
    lastError: string | null;
  } | null;
  bars: DayBar[];
  uptime: { day: number | null; month: number | null; quarter: number | null };
  /** Average response time per 30 minutes over the last 24 hours. */
  latency: { t: number; v: number | null }[];
  incidents: IncidentRow[];
};

export type IncidentRow = {
  id: string;
  kind: "down" | "crashloop" | "resource";
  severity: "warning" | "critical";
  title: string;
  detail: string | null;
  startedAt: string;
  resolvedAt: string | null;
  serviceId: string | null;
  serviceName: string | null;
  projectId: string | null;
  serverId: string | null;
  serverName: string | null;
};

const iso = (d: Date | null) => d?.toISOString() ?? null;

export async function monitorSummary(serviceId: string): Promise<MonitorSummary> {
  const [m] = await db.select().from(schema.monitor).where(eq(schema.monitor.serviceId, serviceId));
  const incidents = await incidentRows({ serviceId, limit: 5 });
  if (!m) return { monitor: null, bars: dailyBars([], 90), uptime: { day: null, month: null, quarter: null }, latency: [], incidents };
  const [daily, checks] = await Promise.all([
    db.select().from(schema.monitorDaily).where(eq(schema.monitorDaily.monitorId, m.id)),
    db
      .select({ ok: schema.monitorCheck.ok, latencyMs: schema.monitorCheck.latencyMs, createdAt: schema.monitorCheck.createdAt })
      .from(schema.monitorCheck)
      .where(and(eq(schema.monitorCheck.monitorId, m.id), gte(schema.monitorCheck.createdAt, new Date(Date.now() - 86400_000)))),
  ]);
  const bars = dailyBars(daily, 90);
  const bucket = 30 * 60_000;
  const start = Math.floor((Date.now() - 86400_000) / bucket) * bucket;
  const latency: MonitorSummary["latency"] = [];
  for (let t = start; t <= Date.now(); t += bucket) {
    const inBucket = checks.filter((c) => c.latencyMs !== null && c.createdAt.getTime() >= t && c.createdAt.getTime() < t + bucket);
    latency.push({ t, v: inBucket.length ? inBucket.reduce((a, c) => a + (c.latencyMs ?? 0), 0) / inBucket.length : null });
  }
  return {
    monitor: {
      enabled: m.enabled,
      kind: m.kind,
      status: m.status,
      url: m.url,
      path: m.path,
      expectedStatus: m.expectedStatus,
      keyword: m.keyword,
      intervalSeconds: m.intervalSeconds,
      timeoutMs: m.timeoutMs,
      failureThreshold: m.failureThreshold,
      lastCheckedAt: iso(m.lastCheckedAt),
      lastLatencyMs: m.lastLatencyMs,
      lastError: m.lastError,
    },
    bars,
    uptime: {
      day: checks.length ? (checks.filter((c) => c.ok).length / checks.length) * 100 : null,
      month: uptimePercent(bars.slice(-30)),
      quarter: uptimePercent(bars),
    },
    latency,
    incidents,
  };
}

/** Incidents with service and server names, newest first. */
export async function incidentRows(filter: { organizationId?: string; serviceId?: string; openOnly?: boolean; limit?: number }): Promise<IncidentRow[]> {
  const where = and(
    filter.organizationId ? eq(schema.incident.organizationId, filter.organizationId) : undefined,
    filter.serviceId ? eq(schema.incident.serviceId, filter.serviceId) : undefined,
    filter.openOnly ? isNull(schema.incident.resolvedAt) : undefined,
  );
  const rows = await db
    .select({
      incident: schema.incident,
      serviceName: schema.service.name,
      projectId: schema.service.projectId,
      serverName: schema.server.name,
    })
    .from(schema.incident)
    .leftJoin(schema.service, eq(schema.incident.serviceId, schema.service.id))
    .leftJoin(schema.server, eq(schema.incident.serverId, schema.server.id))
    .where(where)
    .orderBy(desc(schema.incident.startedAt))
    .limit(filter.limit ?? 50);
  return rows.map((r) => ({
    id: r.incident.id,
    kind: r.incident.kind,
    severity: r.incident.severity,
    title: r.incident.title,
    detail: r.incident.detail,
    startedAt: r.incident.startedAt.toISOString(),
    resolvedAt: iso(r.incident.resolvedAt),
    serviceId: r.incident.serviceId,
    serviceName: r.serviceName,
    projectId: r.projectId,
    serverId: r.incident.serverId,
    serverName: r.serverName,
  }));
}

/** Monitors of an organization's services, for the Monitoring page. */
export async function orgMonitors(organizationId: string) {
  const rows = await db
    .select({ monitor: schema.monitor, service: schema.service, project: schema.project })
    .from(schema.monitor)
    .innerJoin(schema.service, eq(schema.monitor.serviceId, schema.service.id))
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(eq(schema.project.organizationId, organizationId));
  const ids = rows.map((r) => r.monitor.id);
  const daily = ids.length
    ? await db
        .select()
        .from(schema.monitorDaily)
        .where(and(inArray(schema.monitorDaily.monitorId, ids), gte(schema.monitorDaily.day, new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10))))
    : [];
  return rows
    .map((r) => ({
      serviceId: r.service.id,
      serviceName: r.service.name,
      projectId: r.project.id,
      projectName: r.project.name,
      kind: r.monitor.kind,
      status: r.monitor.status,
      enabled: r.monitor.enabled,
      lastLatencyMs: r.monitor.lastLatencyMs,
      lastCheckedAt: iso(r.monitor.lastCheckedAt),
      lastError: r.monitor.lastError,
      bars: dailyBars(
        daily.filter((d) => d.monitorId === r.monitor.id),
        30,
      ),
    }))
    .sort((a, b) => Number(b.status === "down") - Number(a.status === "down") || a.serviceName.localeCompare(b.serviceName));
}
