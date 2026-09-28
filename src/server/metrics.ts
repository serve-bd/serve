import fs from "node:fs/promises";
import os from "node:os";
import { lt, sql as dsql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { docker, LABEL } from "@/server/docker/client";
import { env } from "@/server/env";
import { getSettings } from "@/server/settings";

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

let lastCpu: CpuTimes | null = null;

export async function serverSnapshot() {
  const cpu = await readCpu();
  let percent = 0;
  if (lastCpu) {
    const total = cpu.total - lastCpu.total;
    percent = total > 0 ? (1 - (cpu.idle - lastCpu.idle) / total) * 100 : 0;
  } else {
    await new Promise((r) => setTimeout(r, 250));
    const next = await readCpu();
    const total = next.total - cpu.total;
    percent = total > 0 ? (1 - (next.idle - cpu.idle) / total) * 100 : 0;
  }
  lastCpu = cpu;
  const [memory, disk] = await Promise.all([readMemory(), readDisk()]);
  return {
    cpu: Math.max(0, Math.min(100, percent)),
    cores: os.cpus().length,
    memory,
    disk,
    load: os.loadavg(),
    uptime: os.uptime(),
  };
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

/** Collect per-service and server samples. */
export async function collectMetrics() {
  const containers = await docker.listContainers({ filters: { label: [`${LABEL.managed}=true`] } });
  const byService = new Map<string, { cpu: number; memory: number; memoryLimit: number; rx: number; tx: number }>();
  await Promise.all(
    containers.map(async (c) => {
      const serviceId = c.Labels[LABEL.service];
      if (!serviceId) return;
      try {
        const stats = (await docker.getContainer(c.Id).stats({ stream: false })) as unknown as Stats;
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
  const server = await serverSnapshot();
  const rows = [
    {
      scope: "server",
      cpu: Math.round(server.cpu * 100),
      memory: server.memory.used,
      memoryLimit: server.memory.total,
      disk: server.disk.used,
      diskTotal: server.disk.total,
    },
    ...[...byService.entries()].map(([scope, s]) => ({
      scope,
      cpu: Math.round(s.cpu * 100),
      memory: s.memory,
      memoryLimit: s.memoryLimit,
      netRx: s.rx,
      netTx: s.tx,
    })),
  ];
  await db.insert(schema.metric).values(rows);
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
