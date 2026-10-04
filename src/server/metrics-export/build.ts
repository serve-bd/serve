import { Exposition, type Labels } from "@/lib/prometheus";
import type { DeploymentStatus, ServiceStatus } from "@/server/db/schema";

/*
 * Turns what Serve already stores (the worker's resource samples, container states, request
 * counts from the proxy access log, deployments) into Prometheus metrics. Pure: the caller loads
 * the data, so the format and the organization boundary are tested without a database.
 */

export const SERVICE_STATUSES: ServiceStatus[] = ["idle", "building", "deploying", "running", "stopped", "failed", "crashed", "restarting"];
export const DEPLOYMENT_STATUSES: DeploymentStatus[] = ["waiting", "queued", "building", "deploying", "success", "failed", "cancelled", "superseded"];

/** A resource sample older than this is not shown: the service stopped, or its server stopped reporting. */
export const SAMPLE_MAX_AGE_MS = 180_000;
/** Request rates are the average over this many full minutes before the current one. */
export const REQUEST_WINDOW_MINUTES = 5;

export type ExportService = {
  id: string;
  name: string;
  slug: string;
  type: string;
  status: ServiceStatus;
  organization: string;
  project: string;
  environment: string;
  serverId: string;
};

/** Latest stored sample of a service (the sum over its containers on its server). */
export type ExportSample = {
  /** Percent of one CPU core (150 = one and a half cores). */
  cpuPercent: number;
  memory: number;
  memoryLimit: number | null;
  netRx: number | null;
  netTx: number | null;
  at: number;
};

export type ExportContainer = { serviceId: string; serverId: string; name: string; state: string; restartCount: number | null };

export type ExportServer = {
  id: string;
  name: string;
  reachable: boolean;
  /** Null when no recent host sample is stored. */
  cpuPercent: number | null;
  cores: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  load: number[] | null;
};

export type ExportInput = {
  now: number;
  services: ExportService[];
  serverNames: Map<string, string>;
  samples: Map<string, ExportSample>;
  /** Containers of the servers the services run on; other services' containers are ignored. */
  containers: ExportContainer[];
  /** Requests and 5xx answers per service in the request window; null when the token may not read them. */
  requests: Map<string, { requests: number; s5xx: number }> | null;
  deployments: { serviceId: string; status: string; count: number }[];
  /** Unix milliseconds of the last successful deployment per service. */
  lastDeploy: Map<string, number>;
  /** Host figures of every server; null unless the token belongs to a Root admin. */
  servers: ExportServer[] | null;
};

/** The replica number of a Serve app container (slug-deploy-N), or the container name for others (compose). */
export function replicaOf(slug: string, name: string) {
  const prefix = `${slug}-`;
  if (name.startsWith(prefix)) {
    const m = /^[a-z0-9]{6}-(\d+)$/i.exec(name.slice(prefix.length));
    if (m) return m[1];
  }
  return name;
}

export function buildExposition(input: ExportInput) {
  const out = new Exposition();
  const byId = new Map(input.services.map((s) => [s.id, s]));
  const base = (s: ExportService): Labels => ({
    organization: s.organization,
    project: s.project,
    environment: s.environment,
    service: s.name,
    service_id: s.id,
    server: input.serverNames.get(s.serverId) ?? s.serverId,
  });

  const info = out.gauge("serve_service_info", "Services of the organization; always 1. The type label says app, database or compose.");
  const up = out.gauge("serve_service_up", "1 when the service is running, else 0.");
  const status = out.gauge("serve_service_status", "Status of the service: 1 for the current status, 0 for the others.");
  for (const s of input.services) {
    info({ ...base(s), type: s.type }, 1);
    up(base(s), s.status === "running" ? 1 : 0);
    for (const st of SERVICE_STATUSES) status({ ...base(s), status: st }, s.status === st ? 1 : 0);
  }

  const cpu = out.gauge("serve_service_cpu_cores", "CPU the service uses, in cores (1 = one full core), summed over its containers.");
  const mem = out.gauge("serve_service_memory_bytes", "Memory the service uses in bytes (without file cache), summed over its containers.");
  const memLimit = out.gauge("serve_service_memory_limit_bytes", "Memory limit of one container of the service in bytes (the host memory when it has no limit).");
  const rx = out.counter("serve_service_network_receive_bytes_total", "Bytes received by the service's containers since they started.");
  const tx = out.counter("serve_service_network_transmit_bytes_total", "Bytes sent by the service's containers since they started.");
  const sampled = out.gauge("serve_service_sample_timestamp_seconds", "When the resource figures above were sampled (Unix seconds).");
  for (const s of input.services) {
    const sample = input.samples.get(s.id);
    if (!sample || input.now - sample.at > SAMPLE_MAX_AGE_MS) continue;
    const l = base(s);
    cpu(l, round(sample.cpuPercent / 100, 4));
    mem(l, sample.memory);
    if (sample.memoryLimit) memLimit(l, sample.memoryLimit);
    rx(l, sample.netRx);
    tx(l, sample.netTx);
    sampled(l, Math.floor(sample.at / 1000));
  }

  const replicas = out.gauge("serve_service_replicas_running", "Containers of the service that are running.");
  const replicaUp = out.gauge("serve_replica_up", "1 when the container is running, else 0.");
  const replicaState = out.gauge("serve_replica_state", "Docker state of the container (running, restarting, exited, ...); 1 for the current state.");
  const restarts = out.counter("serve_replica_restarts_total", "Times Docker restarted the container since it was created.");
  const running = new Map<string, number>();
  const seen = new Set<string>();
  for (const c of [...input.containers].sort((a, b) => a.name.localeCompare(b.name))) {
    const s = byId.get(c.serviceId);
    // Another organization's container on a shared server, or one seen twice.
    if (!s || seen.has(`${c.serverId}|${c.name}`)) continue;
    seen.add(`${c.serverId}|${c.name}`);
    const l = { ...base(s), server: input.serverNames.get(c.serverId) ?? c.serverId, replica: replicaOf(s.slug, c.name), container: c.name };
    const isUp = c.state === "running";
    if (isUp) running.set(s.id, (running.get(s.id) ?? 0) + 1);
    replicaUp(l, isUp ? 1 : 0);
    replicaState({ ...l, state: c.state || "unknown" }, 1);
    if (c.restartCount !== null) restarts(l, c.restartCount);
  }
  for (const s of input.services) replicas(base(s), running.get(s.id) ?? 0);

  if (input.requests) {
    const seconds = REQUEST_WINDOW_MINUTES * 60;
    const rate = out.gauge(
      "serve_service_http_requests_per_second",
      `Requests to the service's domains per second, averaged over the last ${REQUEST_WINDOW_MINUTES} full minutes (from the proxy access log).`,
    );
    const errors = out.gauge("serve_service_http_5xx_per_second", `Answers with a 5xx status per second, averaged over the last ${REQUEST_WINDOW_MINUTES} full minutes.`);
    for (const s of input.services) {
      const r = input.requests.get(s.id) ?? { requests: 0, s5xx: 0 };
      rate(base(s), round(r.requests / seconds, 4));
      errors(base(s), round(r.s5xx / seconds, 4));
    }
  }

  const deploysTotal = out.counter("serve_service_deployments_total", "Deployments of the service ever started.");
  const deploys = out.gauge("serve_service_deployments", "Deployments of the service by their current status.");
  const lastDeploy = out.gauge("serve_service_last_deploy_timestamp_seconds", "When the last successful deployment of the service finished (Unix seconds).");
  const counts = new Map<string, Map<string, number>>();
  for (const d of input.deployments) {
    if (!byId.has(d.serviceId)) continue;
    const m = counts.get(d.serviceId) ?? new Map<string, number>();
    m.set(d.status, (m.get(d.status) ?? 0) + d.count);
    counts.set(d.serviceId, m);
  }
  for (const s of input.services) {
    const m = counts.get(s.id) ?? new Map<string, number>();
    deploysTotal(
      base(s),
      [...m.values()].reduce((a, b) => a + b, 0),
    );
    for (const st of new Set([...DEPLOYMENT_STATUSES, ...m.keys()])) deploys({ ...base(s), status: st }, m.get(st) ?? 0);
    const at = input.lastDeploy.get(s.id);
    if (at) lastDeploy(base(s), Math.floor(at / 1000));
  }

  if (input.servers) {
    const reachable = out.gauge("serve_server_up", "1 when Serve can reach the server, else 0.");
    const sCpu = out.gauge("serve_server_cpu_usage_ratio", "CPU use of the whole server, from 0 to 1.");
    const cores = out.gauge("serve_server_cpu_cores", "CPU cores of the server.");
    const memUsed = out.gauge("serve_server_memory_used_bytes", "Memory in use on the server (total minus available).");
    const memTotal = out.gauge("serve_server_memory_total_bytes", "Memory of the server.");
    const diskUsed = out.gauge("serve_server_disk_used_bytes", "Disk space used on the volume that holds Serve's data.");
    const diskTotal = out.gauge("serve_server_disk_total_bytes", "Size of the volume that holds Serve's data.");
    const load = [
      out.gauge("serve_server_load1", "Load average over 1 minute."),
      out.gauge("serve_server_load5", "Load average over 5 minutes."),
      out.gauge("serve_server_load15", "Load average over 15 minutes."),
    ];
    for (const sv of input.servers) {
      const l = { server: sv.name, server_id: sv.id };
      reachable(l, sv.reachable ? 1 : 0);
      sCpu(l, sv.cpuPercent === null ? null : round(sv.cpuPercent / 100, 4));
      cores(l, sv.cores);
      memUsed(l, sv.memoryUsed);
      memTotal(l, sv.memoryTotal);
      diskUsed(l, sv.diskUsed);
      diskTotal(l, sv.diskTotal);
      for (const [i, v] of (sv.load ?? []).slice(0, 3).entries()) load[i](l, round(v, 2));
    }
  }

  return out.render();
}

function round(n: number, digits: number) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
