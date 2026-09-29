import os from "node:os";
import { docker } from "@/server/docker/client";
import { proxyStatus } from "@/server/proxy/nginx";
import { commandExists, run } from "@/server/process";
import { serverSnapshot } from "@/server/metrics";

export async function detectPublicIp(): Promise<string | null> {
  for (const url of ["https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com"]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { "user-agent": "curl/8" } });
      const ip = (await res.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
    } catch {
      // try next
    }
  }
  return null;
}

export async function systemStatus() {
  let dockerVersion: string | null = null;
  let dockerError: string | null = null;
  try {
    const v = await docker.version();
    dockerVersion = v.Version;
  } catch (e) {
    dockerError = (e as Error).message;
  }
  const [proxy, nixpacks] = await Promise.all([proxyStatus().catch(() => null), commandExists("nixpacks")]);
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpus: os.cpus().length,
    memory: os.totalmem(),
    dockerVersion,
    dockerError,
    proxy,
    nixpacks,
  };
}

export { resolveA } from "@/server/dns";

/** Docker disk usage summary (images, containers, volumes, build cache). */
export async function dockerDiskUsage() {
  try {
    const df = (await docker.df()) as {
      LayersSize?: number;
      Images?: { Size: number; Containers: number }[];
      Containers?: { SizeRw?: number }[];
      Volumes?: { UsageData?: { Size: number; RefCount: number } }[];
      BuildCache?: { Size: number; InUse: boolean }[];
    };
    const images = df.Images ?? [];
    const volumes = df.Volumes ?? [];
    const cache = df.BuildCache ?? [];
    return {
      images: { count: images.length, size: df.LayersSize ?? images.reduce((a, i) => a + i.Size, 0), unused: images.filter((i) => i.Containers === 0).length },
      containers: { count: (df.Containers ?? []).length, size: (df.Containers ?? []).reduce((a, c) => a + (c.SizeRw ?? 0), 0) },
      volumes: { count: volumes.length, size: volumes.reduce((a, v) => a + Math.max(0, v.UsageData?.Size ?? 0), 0) },
      buildCache: { count: cache.length, size: cache.reduce((a, c) => a + c.Size, 0) },
    };
  } catch {
    return null;
  }
}

/** Host details from the Docker daemon (the dashboard itself may run in a container). */
export async function hostInfo() {
  const [info, compose, buildx] = await Promise.all([
    docker.info().catch(() => null) as Promise<{
      Name?: string;
      OperatingSystem?: string;
      KernelVersion?: string;
      Architecture?: string;
      NCPU?: number;
      MemTotal?: number;
      ServerVersion?: string;
      Containers?: number;
      ContainersRunning?: number;
      Images?: number;
      DockerRootDir?: string;
      Driver?: string;
    } | null>,
    run("docker", ["compose", "version", "--short"]).then((r) => r.trim() || null).catch(() => null),
    run("docker", ["buildx", "version"]).then((r) => r.trim().split(" ")[1] ?? null).catch(() => null),
  ]);
  return {
    name: info?.Name ?? os.hostname(),
    os: info?.OperatingSystem ?? `${os.type()} ${os.release()}`,
    kernel: info?.KernelVersion ?? os.release(),
    arch: info?.Architecture ?? os.arch(),
    cpus: info?.NCPU ?? os.cpus().length,
    memory: info?.MemTotal ?? os.totalmem(),
    docker: info?.ServerVersion ?? null,
    compose,
    buildx,
    storageDriver: info?.Driver ?? null,
    dockerRoot: info?.DockerRootDir ?? null,
    containers: { total: info?.Containers ?? 0, running: info?.ContainersRunning ?? 0 },
    images: info?.Images ?? 0,
    // /proc/uptime is the host's, even inside a container.
    upSince: new Date(Date.now() - os.uptime() * 1000).toISOString(),
  };
}

export type ServerHealth = { docker: boolean; proxy: boolean; worker: boolean; diskPercent: number; issues: string[] };

/** Quick health summary for the server header. */
export async function serverHealth(settings: { workerHeartbeat: string | null; cleanupDiskThreshold: number }): Promise<ServerHealth> {
  const [dockerOk, proxy, snap] = await Promise.all([
    docker.ping().then(() => true).catch(() => false),
    proxyStatus().catch(() => null),
    serverSnapshot().catch(() => null),
  ]);
  const worker = !!settings.workerHeartbeat && Date.now() - new Date(settings.workerHeartbeat).getTime() < 60_000;
  const diskPercent = snap && snap.disk.total ? (snap.disk.used / snap.disk.total) * 100 : 0;
  const issues: string[] = [];
  if (!dockerOk) issues.push("Docker is not reachable");
  if (!proxy?.running) issues.push("The nginx proxy is not running");
  if (!worker) issues.push("The worker is not running");
  if (diskPercent >= settings.cleanupDiskThreshold) issues.push(`Disk is ${Math.round(diskPercent)}% full`);
  return { docker: dockerOk, proxy: !!proxy?.running, worker, diskPercent, issues };
}
