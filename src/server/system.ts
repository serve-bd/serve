import os from "node:os";
import { docker } from "@/server/docker/client";
import { proxyStatus } from "@/server/proxy/nginx";
import { commandExists, run } from "@/server/process";
import { serverSnapshot } from "@/server/metrics";
import { getServer, LOCAL_SERVER_ID, type ServerCtx } from "@/server/servers/context";

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

/** Docker disk usage summary (images, containers, volumes, build cache) of a server. */
export async function dockerDiskUsage(ctx?: ServerCtx) {
  const d = ctx?.docker ?? docker;
  try {
    const df = (await d.df()) as {
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

type DockerInfo = {
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
};

/** Host details of a server, from its Docker daemon (the dashboard itself may run in a container). */
export async function hostInfo(ctx?: ServerCtx) {
  const c = ctx ?? (await getServer(LOCAL_SERVER_ID));
  const info = (await c.docker.info().catch(() => null)) as DockerInfo | null;
  let compose: string | null;
  let buildx: string | null;
  let uptime: number;
  if (c.local) {
    [compose, buildx] = await Promise.all([
      run("docker", ["compose", "version", "--short"]).then((r) => r.trim() || null).catch(() => null),
      run("docker", ["buildx", "version"]).then((r) => r.trim().split(" ")[1] ?? null).catch(() => null),
    ]);
    // /proc/uptime is the host's, even inside a container.
    uptime = os.uptime();
  } else {
    const r = await c
      .exec("docker compose version --short 2>/dev/null; echo '|'; docker buildx version 2>/dev/null | cut -d' ' -f2; echo '|'; cut -d' ' -f1 /proc/uptime", { timeoutMs: 15_000 })
      .catch(() => null);
    const [a, b, u] = (r?.stdout ?? "||").split("|").map((x) => x.trim());
    compose = a || null;
    buildx = b || null;
    uptime = Number(u) || 0;
  }
  const facts = c.row.info ?? {};
  return {
    name: info?.Name ?? (c.local ? os.hostname() : c.row.name),
    os: info?.OperatingSystem ?? facts.os ?? (c.local ? `${os.type()} ${os.release()}` : "Unknown"),
    kernel: info?.KernelVersion ?? facts.kernel ?? (c.local ? os.release() : ""),
    arch: info?.Architecture ?? facts.arch ?? (c.local ? os.arch() : ""),
    cpus: info?.NCPU ?? facts.cpus ?? (c.local ? os.cpus().length : 0),
    memory: info?.MemTotal ?? facts.memory ?? (c.local ? os.totalmem() : 0),
    docker: info?.ServerVersion ?? null,
    compose,
    buildx,
    storageDriver: info?.Driver ?? null,
    dockerRoot: info?.DockerRootDir ?? null,
    containers: { total: info?.Containers ?? 0, running: info?.ContainersRunning ?? 0 },
    images: info?.Images ?? 0,
    upSince: uptime ? new Date(Date.now() - uptime * 1000).toISOString() : null,
  };
}

export type ServerHealth = { docker: boolean; proxy: boolean; worker: boolean; reachable: boolean; diskPercent: number; issues: string[] };
type HealthSettings = { workerHeartbeat: string | null; cleanupDiskThreshold: number };

async function proxyRunning(ctx: ServerCtx) {
  const info = await ctx.docker.getContainer(ctx.proxyContainer).inspect().catch(() => null);
  return !!info?.State.Running;
}

/**
 * Quick health summary for a server header.
 * `serverHealth(settings)` checks the local server; `serverHealth(ctx, settings)` any server.
 */
export async function serverHealth(settings: HealthSettings): Promise<ServerHealth>;
export async function serverHealth(ctx: ServerCtx | null | undefined, settings: HealthSettings): Promise<ServerHealth>;
export async function serverHealth(a: ServerCtx | HealthSettings | null | undefined, b?: HealthSettings): Promise<ServerHealth> {
  const settings = (b ?? a) as HealthSettings;
  const ctx = b ? ((a as ServerCtx | null) ?? (await getServer(LOCAL_SERVER_ID))) : await getServer(LOCAL_SERVER_ID);
  const worker = !!settings.workerHeartbeat && Date.now() - new Date(settings.workerHeartbeat).getTime() < 60_000;
  const reachable = ctx.local || ctx.row.status !== "unreachable";
  const withTimeout = <T>(p: Promise<T>, fallback: T) => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), 8000))]);
  const [dockerOk, proxy, snap] = reachable
    ? await Promise.all([
        withTimeout(
          ctx.docker.ping().then(() => true).catch(() => false),
          false,
        ),
        withTimeout(proxyRunning(ctx), false),
        withTimeout(serverSnapshot(ctx).catch(() => null), null),
      ])
    : [false, false, null];
  const diskPercent = snap && snap.disk.total ? (snap.disk.used / snap.disk.total) * 100 : 0;
  const issues: string[] = [];
  if (!reachable) issues.push(ctx.row.statusMessage ? `Unreachable: ${ctx.row.statusMessage}` : "The server is unreachable");
  else if (!dockerOk) issues.push("Docker is not reachable");
  if (reachable && !proxy) issues.push("The nginx proxy is not running");
  if (!worker) issues.push("The worker is not running");
  if (diskPercent >= settings.cleanupDiskThreshold) issues.push(`Disk is ${Math.round(diskPercent)}% full`);
  return { docker: dockerOk, proxy, worker, reachable, diskPercent, issues };
}
