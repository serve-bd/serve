import fs from "node:fs/promises";
import os from "node:os";
import { and, eq, inArray, lt, sql as dsql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LABEL } from "@/server/docker/client";
import { env } from "@/server/env";
import { getSettings } from "@/server/settings";
import { getServer, LOCAL_SERVER_ID, type ServerCtx } from "@/server/servers/context";
import { sh } from "@/server/servers/ssh";

type CpuTimes = { idle: number; total: number };

async function readCpu(): Promise<CpuTimes> {
  try {
    const stat = await fs.readFile("/proc/stat", "utf8");
    const parts = stat.split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] ?? 0);
    return { idle, total: parts.reduce((a, b) => a + b, 0) };
  } catch {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const c of cpus) {
      idle += c.times.idle;
      total += c.times.idle + c.times.user + c.times.sys + c.times.irq + c.times.nice;
    }
    return { idle, total };
  }
}

async function readMemory() {
  try {
    const info = await fs.readFile("/proc/meminfo", "utf8");
    const get = (k: string) => Number(info.match(new RegExp(`^${k}:\\s+(\\d+)`, "m"))?.[1] ?? 0) * 1024;
    const total = get("MemTotal");
    return { total, used: total - get("MemAvailable") };
  } catch {
    return { total: os.totalmem(), used: os.totalmem() - os.freemem() };
  }
}

async function readDisk() {
  try {
    const s = await fs.statfs(env.dataDir);
    return { total: s.blocks * s.bsize, used: (s.blocks - s.bfree) * s.bsize };
  } catch {
    return { total: 0, used: 0 };
  }
}

const lastCpu = new Map<string, CpuTimes>();

export type ServerSnapshot = {
  cpu: number;
  cores: number;
  memory: { total: number; used: number };
  disk: { total: number; used: number };
  load: number[];
  uptime: number;
};

function cpuPercent(prev: CpuTimes, next: CpuTimes) {
  const total = next.total - prev.total;
  return total > 0 ? Math.max(0, Math.min(100, (1 - (next.idle - prev.idle) / total) * 100)) : 0;
}

function parseCpuLine(line: string): CpuTimes {
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  return { idle: parts[3] + (parts[4] ?? 0), total: parts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) };
}

async function localSnapshot(): Promise<ServerSnapshot> {
  const cpu = await readCpu();
  const prev = lastCpu.get(LOCAL_SERVER_ID);
  let percent: number;
  if (prev) percent = cpuPercent(prev, cpu);
  else {
    await new Promise((r) => setTimeout(r, 250));
    percent = cpuPercent(cpu, await readCpu());
  }
  lastCpu.set(LOCAL_SERVER_ID, cpu);
  const [memory, disk] = await Promise.all([readMemory(), readDisk()]);
  return { cpu: percent, cores: os.cpus().length, memory, disk, load: os.loadavg(), uptime: os.uptime() };
}

/** One SSH round trip: CPU (twice when there is no previous sample), memory, disk, load, uptime. */
async function remoteSnapshot(ctx: ServerCtx): Promise<ServerSnapshot> {
  const prev = lastCpu.get(ctx.id);
  const dir = sh(ctx.paths.root);
  const script = [
    "head -1 /proc/stat",
    prev ? "echo" : "sleep 0.3; head -1 /proc/stat",
    "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo | tr -s ' ' | cut -d' ' -f2 | paste -sd' ' -",
    `(df -Pk ${dir} 2>/dev/null || df -Pk /) | tail -1`,
    "cut -d' ' -f1-3 /proc/loadavg",
    "cut -d' ' -f1 /proc/uptime",
    "nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo",
  ].join("; ");
  const r = await ctx.exec(script, { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Could not read server statistics");
  const lines = r.stdout.split("\n");
  const first = parseCpuLine(lines[0]);
  let percent: number;
  let latest = first;
  if (prev) percent = cpuPercent(prev, first);
  else {
    latest = parseCpuLine(lines[1]);
    percent = cpuPercent(first, latest);
  }
  lastCpu.set(ctx.id, latest);
  const [memTotalKb, memAvailKb] = (lines[2] ?? "").split(" ").map(Number);
  const df = (lines[3] ?? "").trim().split(/\s+/);
  const diskTotal = Number(df[1] ?? 0) * 1024;
  const diskUsed = Number(df[2] ?? 0) * 1024;
  return {
    cpu: percent,
    cores: Number(lines[6]) || ctx.row.info.cpus || 1,
    memory: { total: (memTotalKb || 0) * 1024, used: ((memTotalKb || 0) - (memAvailKb || 0)) * 1024 },
    disk: { total: diskTotal, used: diskUsed },
    load: (lines[4] ?? "").split(" ").map(Number).filter(Number.isFinite),
    uptime: Number(lines[5]) || 0,
  };
}

/** Host CPU, memory and disk of a server (the local one by default). */
export async function serverSnapshot(ctx?: ServerCtx): Promise<ServerSnapshot> {
  if (!ctx || ctx.local) return localSnapshot();
  return remoteSnapshot(ctx);
}

/** Metric scope for a server's own samples. The local server keeps the historical "server" scope. */
export function serverScope(serverId: string) {
  return serverId === LOCAL_SERVER_ID ? "server" : `server:${serverId}`;
}

type Stats = {
  cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number };
  memory_stats: { usage?: number; limit?: number; stats?: { inactive_file?: number; cache?: number } };
  networks?: Record<string, { rx_bytes: number; tx_bytes: number }>;
};

export function statsToSample(s: Stats) {
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
  const sysDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0);
  const cpus = s.cpu_stats.online_cpus ?? 1;
  const cpu = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
  const cache = s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.cache ?? 0;
  const memory = Math.max(0, (s.memory_stats.usage ?? 0) - cache);
  let rx = 0;
  let tx = 0;
  for (const n of Object.values(s.networks ?? {})) {
    rx += n.rx_bytes;
    tx += n.tx_bytes;
  }
  return { cpu, memory, memoryLimit: s.memory_stats.limit ?? 0, rx, tx };
}

type Agg = { cpu: number; memory: number; memoryLimit: number; rx: number; tx: number };

async function collectFor(ctx: ServerCtx) {
  const containers = await ctx.docker.listContainers({ filters: { label: [`${LABEL.managed}=true`] } });
  const byService = new Map<string, Agg>();
  await Promise.all(
    containers.map(async (c) => {
      const serviceId = c.Labels[LABEL.service];
      if (!serviceId) return;
      try {
        const stats = (await ctx.docker.getContainer(c.Id).stats({ stream: false })) as unknown as Stats;
        const s = statsToSample(stats);
        const agg = byService.get(serviceId) ?? { cpu: 0, memory: 0, memoryLimit: 0, rx: 0, tx: 0 };
        agg.cpu += s.cpu;
        agg.memory += s.memory;
        agg.memoryLimit = Math.max(agg.memoryLimit, s.memoryLimit);
        agg.rx += s.rx;
        agg.tx += s.tx;
        byService.set(serviceId, agg);
      } catch {
        // container went away
      }
    }),
  );
  // Only record services that belong to this server: another Serve instance may share the Docker host.
  const ids = [...byService.keys()];
  const owned = ids.length
    ? new Set(
        (
          await db
            .select({ id: schema.service.id })
            .from(schema.service)
            .where(and(inArray(schema.service.id, ids), eq(schema.service.serverId, ctx.id)))
        ).map((r) => r.id),
      )
    : new Set<string>();
  const server = await serverSnapshot(ctx);
  return [
    {
      scope: serverScope(ctx.id),
      cpu: Math.round(server.cpu * 100),
      memory: server.memory.used,
      memoryLimit: server.memory.total,
      disk: server.disk.used,
      diskTotal: server.disk.total,
    },
    ...[...byService.entries()]
      .filter(([scope]) => owned.has(scope))
      .map(([scope, s]) => ({
        scope,
        cpu: Math.round(s.cpu * 100),
        memory: s.memory,
        memoryLimit: s.memoryLimit,
        netRx: s.rx,
        netTx: s.tx,
      })),
  ];
}

/** Collect per-service and server samples on every reachable server. */
export async function collectMetrics() {
  const servers = await db.select({ id: schema.server.id, isLocal: schema.server.isLocal, status: schema.server.status }).from(schema.server);
  const results = await Promise.allSettled(servers.filter((s) => s.isLocal || s.status === "ready").map(async (s) => collectFor(await getServer(s.id))));
  const rows = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (rows.length) await db.insert(schema.metric).values(rows);
  const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  if (failed && !rows.length) throw failed.reason;
}

export async function pruneMetrics() {
  const { metricsRetentionHours } = await getSettings();
  await db.delete(schema.metric).where(lt(schema.metric.createdAt, new Date(Date.now() - metricsRetentionHours * 3600_000)));
}

/** Downsampled series for charts: average per bucket. */
export async function metricSeries(scope: string, hours = 6, buckets = 72) {
  const since = new Date(Date.now() - hours * 3600_000);
  const bucketSeconds = Math.max(30, Math.floor((hours * 3600) / buckets));
  const rows = await db.execute<{
    t: string;
    cpu: number;
    memory: number;
    memory_limit: number;
    net_rx: number | null;
    net_tx: number | null;
    disk: number | null;
    disk_total: number | null;
  }>(dsql`
    SELECT to_timestamp(floor(extract(epoch FROM created_at) / ${bucketSeconds}) * ${bucketSeconds}) AS t,
      avg(cpu)::float / 100 AS cpu, avg(memory)::float AS memory, max(memory_limit)::float AS memory_limit,
      max(net_rx)::float AS net_rx, max(net_tx)::float AS net_tx,
      avg(disk)::float AS disk, max(disk_total)::float AS disk_total
    FROM metric WHERE scope = ${scope} AND created_at >= ${since.toISOString()}::timestamptz
    GROUP BY 1 ORDER BY 1
  `);
  return [...rows].map((r) => ({
    t: new Date(r.t).getTime(),
    cpu: Number(r.cpu),
    memory: Number(r.memory),
    memoryLimit: Number(r.memory_limit),
    netRx: r.net_rx === null ? null : Number(r.net_rx),
    netTx: r.net_tx === null ? null : Number(r.net_tx),
    disk: r.disk === null ? null : Number(r.disk),
    diskTotal: r.disk_total === null ? null : Number(r.disk_total),
  }));
}

/** Most recent sample per service from the last few minutes (excludes the server scope). */
export async function latestServiceSamples(maxAgeSeconds = 180) {
  const rows = await db.execute<{ scope: string; cpu: number; memory: number; memory_limit: number | null; created_at: string }>(dsql`
    SELECT DISTINCT ON (scope) scope, cpu, memory, memory_limit, created_at
    FROM metric
    WHERE scope <> 'server' AND scope NOT LIKE 'server:%' AND created_at >= now() - make_interval(secs => ${maxAgeSeconds}::int)
    ORDER BY scope, created_at DESC
  `);
  return [...rows].map((r) => ({
    serviceId: r.scope,
    cpu: Number(r.cpu) / 100,
    memory: Number(r.memory),
    memoryLimit: r.memory_limit === null ? null : Number(r.memory_limit),
    at: new Date(r.created_at).toISOString(),
  }));
}
