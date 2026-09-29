import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { newId } from "@/server/id";
import { LABEL, listServiceContainers } from "@/server/docker/client";
import { getServer, serverOf } from "@/server/servers/context";
import { serverScope } from "@/server/metrics";
import { getSettings } from "@/server/settings";
import { orgOfService } from "@/server/notify";
import { publicGet } from "@/server/net/public-fetch";
import { pickPrimaryDomain } from "@/lib/domains";
import { openIncident, openIncidentFor, resolveIncident } from "./incidents";
import { alertActive, dayKey, isCrashLooping, nextMonitorState, parseExpectedStatus, type RestartSample } from "./state";
import { alertsFor } from "./config";

type Monitor = typeof schema.monitor.$inferSelect;
type Service = typeof schema.service.$inferSelect;

export type CheckResult = { ok: boolean; latencyMs: number | null; statusCode: number | null; error: string | null };

const MAX_BODY = 512 * 1024;
const CONCURRENCY = 8;

/** Servers whose Docker can be asked right now. */
async function reachableServerIds() {
  const rows = await db.select({ id: schema.server.id, isLocal: schema.server.isLocal, status: schema.server.status }).from(schema.server);
  return new Set(rows.filter((r) => r.isLocal || r.status === "ready").map((r) => r.id));
}

/** The URL an HTTP monitor checks: its own URL, or the service's primary domain plus the path. */
export async function monitorUrl(m: Pick<Monitor, "url" | "path">, serviceId: string): Promise<string | null> {
  if (m.url) return m.url;
  const domains = await db.select().from(schema.domain).where(eq(schema.domain.serviceId, serviceId));
  const primary = pickPrimaryDomain(domains);
  if (!primary) return null;
  const path = m.path.startsWith("/") ? m.path : `/${m.path}`;
  return `${primary.https || primary.tunnelId ? "https" : "http"}://${primary.hostname}${path}`;
}

/** One HTTP check. Private addresses are refused, like every URL Serve fetches for users. */
export async function httpCheck(m: Pick<Monitor, "url" | "path" | "expectedStatus" | "keyword" | "timeoutMs">, serviceId: string): Promise<CheckResult> {
  const url = await monitorUrl(m, serviceId);
  if (!url) return { ok: false, latencyMs: null, statusCode: null, error: "The service has no domain to check. Add one or set a URL." };
  const accept = parseExpectedStatus(m.expectedStatus) ?? parseExpectedStatus("200-399")!;
  const started = Date.now();
  try {
    const res = await publicGet(url, { timeoutMs: m.timeoutMs, maxRedirects: 5 });
    let latency = Date.now() - started;
    let error: string | null = accept(res.status) ? null : `HTTP ${res.status}`;
    if (!error && m.keyword) {
      let body = "";
      for await (const chunk of res.body) {
        body += chunk.toString("utf8");
        if (body.length > MAX_BODY) break;
      }
      latency = Date.now() - started;
      if (!body.includes(m.keyword)) error = `The response does not contain "${m.keyword}"`;
    } else {
      res.body.resume();
    }
    return { ok: !error, latencyMs: latency, statusCode: res.status, error };
  } catch (e) {
    return { ok: false, latencyMs: null, statusCode: null, error: (e as Error).message.slice(0, 300) };
  }
}

/** Container check: every container of the current deployment is running and not unhealthy. */
export async function containerCheck(service: Service): Promise<CheckResult> {
  const started = Date.now();
  try {
    const server = await serverOf(service);
    const all = await listServiceContainers(service.id, true, server.docker);
    const relevant = service.type === "app" ? all.filter((c) => c.Labels[LABEL.deployment] === service.currentDeploymentId) : all;
    if (!relevant.length) return { ok: false, latencyMs: null, statusCode: null, error: "No containers" };
    const bad = relevant.find((c) => c.State !== "running" || /\(unhealthy\)/.test(c.Status));
    const latency = Date.now() - started;
    if (bad)
      return {
        ok: false,
        latencyMs: latency,
        statusCode: null,
        error: `${bad.Names[0]?.replace(/^\//, "") ?? "A container"} is ${/unhealthy/.test(bad.Status) ? "unhealthy" : bad.State}`,
      };
    return { ok: true, latencyMs: latency, statusCode: null, error: null };
  } catch (e) {
    return { ok: false, latencyMs: null, statusCode: null, error: (e as Error).message.slice(0, 300) };
  }
}

/** Store a check: raw row, daily rollup and the monitor's state. Opens or resolves the down incident. */
export async function recordCheck(m: Monitor, service: Service, result: CheckResult) {
  const now = new Date();
  await db.insert(schema.monitorCheck).values({ id: newId(), monitorId: m.id, ok: result.ok, latencyMs: result.latencyMs, statusCode: result.statusCode, error: result.error });
  await db
    .insert(schema.monitorDaily)
    .values({ monitorId: m.id, day: dayKey(now), checks: 1, failures: result.ok ? 0 : 1, latencySum: result.latencyMs ?? 0, latencyCount: result.latencyMs === null ? 0 : 1 })
    .onConflictDoUpdate({
      target: [schema.monitorDaily.monitorId, schema.monitorDaily.day],
      set: {
        checks: sql`${schema.monitorDaily.checks} + 1`,
        failures: sql`${schema.monitorDaily.failures} + ${result.ok ? 0 : 1}`,
        latencySum: sql`${schema.monitorDaily.latencySum} + ${result.latencyMs ?? 0}`,
        latencyCount: sql`${schema.monitorDaily.latencyCount} + ${result.latencyMs === null ? 0 : 1}`,
      },
    });
  const next = nextMonitorState(m, result.ok, m.failureThreshold);
  await db
    .update(schema.monitor)
    .set({ status: next.status, consecutiveFailures: next.consecutiveFailures, lastCheckedAt: now, lastLatencyMs: result.latencyMs, lastError: result.error })
    .where(eq(schema.monitor.id, m.id));

  const url = `/projects/${service.projectId}/services/${service.id}`;
  if (next.transition === "down") {
    const org = await orgOfService(service.id);
    if (org) {
      await openIncident({
        organizationId: org,
        key: `down:${service.id}`,
        kind: "down",
        serviceId: service.id,
        title: `${service.name} is down`,
        detail: `${result.error ?? "The check failed"} (${next.consecutiveFailures} checks in a row).`,
        event: "service.down",
        url,
      });
    }
  } else if (next.transition === "recovered") {
    await resolveIncident(`down:${service.id}`, { event: "service.recovered", title: `${service.name} is back up`, body: "The uptime check passes again.", url });
  }
  return next;
}

/** Run every monitor that is due. Services that are stopped on purpose count as paused. */
export async function runUptimeChecks() {
  const rows = await db
    .select({ monitor: schema.monitor, service: schema.service })
    .from(schema.monitor)
    .innerJoin(schema.service, eq(schema.monitor.serviceId, schema.service.id))
    .where(eq(schema.monitor.enabled, true));
  const reachable = await reachableServerIds();
  const now = Date.now();
  const due = [];
  for (const r of rows) {
    if (["stopped", "idle"].includes(r.service.status) || r.service.parentServiceId) {
      if (r.monitor.status !== "paused") {
        await db.update(schema.monitor).set({ status: "paused", consecutiveFailures: 0 }).where(eq(schema.monitor.id, r.monitor.id));
        // A service that is stopped on purpose is not an outage.
        await resolveIncident(`down:${r.service.id}`);
      }
      continue;
    }
    // Container checks need the server; an unreachable server is reported by the server check.
    if (r.monitor.kind === "container" && !reachable.has(r.service.serverId)) continue;
    const last = r.monitor.lastCheckedAt?.getTime() ?? 0;
    if (now - last >= r.monitor.intervalSeconds * 1000 - 2000) due.push(r);
  }
  for (let i = 0; i < due.length; i += CONCURRENCY) {
    await Promise.allSettled(
      due.slice(i, i + CONCURRENCY).map(async ({ monitor, service }) => {
        const result = monitor.kind === "container" ? await containerCheck(service) : await httpCheck(monitor, service.id);
        await recordCheck(monitor, service, result);
      }),
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                               Crash loops                                  */
/* -------------------------------------------------------------------------- */

const restartSamples = new Map<string, RestartSample[]>();

/**
 * Watch restart counts of Serve's containers. A container that Docker restarted three or
 * more times within ten minutes opens a crash-loop incident for its service.
 */
export async function checkContainerHealth() {
  const reachable = await reachableServerIds();
  const now = Date.now();
  const looping = new Map<string, { container: string; restarts: number; oom: boolean; exitCode: number }>();
  const seenServices = new Set<string>();
  for (const serverId of reachable) {
    const ctx = await getServer(serverId).catch(() => null);
    if (!ctx) continue;
    const containers = await ctx.docker.listContainers({ all: true, filters: { label: [`${LABEL.managed}=true`] } }).catch(() => []);
    for (const c of containers) {
      const serviceId = c.Labels[LABEL.service];
      if (!serviceId) continue;
      seenServices.add(serviceId);
      const info = await ctx.docker
        .getContainer(c.Id)
        .inspect()
        .catch(() => null);
      if (!info) continue;
      const samples = restartSamples.get(c.Id) ?? [];
      samples.push({ at: now, restartCount: info.RestartCount ?? 0 });
      while (samples.length && now - samples[0].at > 15 * 60_000) samples.shift();
      restartSamples.set(c.Id, samples);
      if (isCrashLooping(samples, now) || info.State.Restarting) {
        const first = samples[0]?.restartCount ?? 0;
        looping.set(serviceId, {
          container: info.Name.replace(/^\//, ""),
          restarts: (info.RestartCount ?? 0) - first,
          oom: !!info.State.OOMKilled,
          exitCode: info.State.ExitCode,
        });
      }
    }
  }
  // Forget containers that no longer exist.
  for (const [id, samples] of restartSamples) if (now - (samples.at(-1)?.at ?? 0) > 15 * 60_000) restartSamples.delete(id);

  const services = seenServices.size
    ? await db
        .select()
        .from(schema.service)
        .where(inArray(schema.service.id, [...seenServices]))
    : [];
  for (const service of services) {
    const loop = looping.get(service.id);
    const key = `crashloop:${service.id}`;
    const url = `/projects/${service.projectId}/services/${service.id}/logs`;
    if (loop) {
      const org = await orgOfService(service.id);
      if (!org) continue;
      const why = loop.oom ? "It ran out of memory (OOM killed)." : `Last exit code ${loop.exitCode}.`;
      await openIncident({
        organizationId: org,
        key,
        kind: "crashloop",
        serviceId: service.id,
        title: `${service.name} keeps restarting`,
        detail: `${loop.container} restarted ${Math.max(loop.restarts, 1)} times in the last minutes. ${why} Check its logs.`,
        event: "container.crashloop",
        url,
      });
    } else if (await openIncidentFor(key)) {
      await resolveIncident(key, { event: "service.recovered", title: `${service.name} stopped restarting`, body: "Its containers have been stable for a while.", url });
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                              Server resources                              */
/* -------------------------------------------------------------------------- */

type Resource = "disk" | "memory" | "cpu";

/**
 * Compare each server's recent samples (collected every 30 s) with its thresholds. Alerts
 * use hysteresis: they clear only 5 points below the threshold.
 */
export async function checkServerResources() {
  const settings = await getSettings();
  const org = settings.rootOrganizationId;
  if (!org) return;
  const servers = await db.select().from(schema.server);
  for (const server of servers) {
    const config = await alertsFor(server.id);
    const keys = { disk: `resource:${server.id}:disk`, memory: `resource:${server.id}:memory`, cpu: `resource:${server.id}:cpu` } as const;
    if (!config.enabled) {
      for (const k of Object.values(keys)) await resolveIncident(k);
      continue;
    }
    const since = new Date(Date.now() - Math.max(config.cpuMinutes, 3) * 60_000 - 30_000);
    const samples = await db
      .select()
      .from(schema.metric)
      .where(and(eq(schema.metric.scope, serverScope(server.id)), gte(schema.metric.createdAt, since)))
      .orderBy(desc(schema.metric.createdAt));
    if (!samples.length) continue;
    const latest = samples[0];
    const values: Record<Resource, number | null> = {
      disk: latest.diskTotal ? ((latest.disk ?? 0) / latest.diskTotal) * 100 : null,
      memory: latest.memoryLimit ? (latest.memory / latest.memoryLimit) * 100 : null,
      // CPU counts only when it stayed high over the whole window, not for one spike.
      cpu:
        samples.filter((s) => Date.now() - s.createdAt.getTime() <= config.cpuMinutes * 60_000).length >= 2
          ? Math.min(...samples.filter((s) => Date.now() - s.createdAt.getTime() <= config.cpuMinutes * 60_000).map((s) => s.cpu / 100))
          : null,
    };
    const where = server.isLocal ? "this server" : server.name;
    const url = `/servers/${server.id}`;
    for (const resource of ["disk", "memory", "cpu"] as const) {
      const value = values[resource];
      if (value === null) continue;
      const open = await openIncidentFor(keys[resource]);
      const threshold = resource === "disk" ? config.diskWarn : resource === "memory" ? config.memory : config.cpu;
      if (alertActive(value, threshold, !!open)) {
        const critical = resource === "disk" ? value >= config.diskCritical : value >= Math.min(99, threshold + 5);
        const label = resource === "disk" ? "Disk" : resource === "memory" ? "Memory" : "CPU";
        await openIncident({
          organizationId: org,
          key: keys[resource],
          kind: "resource",
          serverId: server.id,
          severity: critical ? "critical" : "warning",
          title: `${label} at ${Math.round(value)}% on ${where}`,
          detail:
            resource === "disk"
              ? "Remove unused images and volumes (Server → Docker cleanup) or grow the disk."
              : resource === "memory"
                ? "Containers may be killed when memory runs out. Set memory limits or add memory."
                : `CPU stayed above ${threshold}% for ${config.cpuMinutes} minutes.`,
          event: "server.resource",
          url,
        });
      } else if (open) {
        await resolveIncident(keys[resource], {
          event: "server.resource",
          title: `${resource === "disk" ? "Disk" : resource === "memory" ? "Memory" : "CPU"} back to normal on ${where}`,
          body: `Now at ${Math.round(value)}%.`,
          url,
        });
      }
    }
  }
}

/** Drop raw checks older than two days and rollups older than 120 days. */
export async function pruneMonitoring() {
  await db.delete(schema.monitorCheck).where(lt(schema.monitorCheck.createdAt, new Date(Date.now() - 2 * 86400_000)));
  await db.delete(schema.monitorDaily).where(lt(schema.monitorDaily.day, dayKey(new Date(Date.now() - 120 * 86400_000))));
}
