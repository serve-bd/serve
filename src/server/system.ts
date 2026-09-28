import os from "node:os";
import { docker } from "@/server/docker/client";
import { proxyStatus } from "@/server/proxy/nginx";
import { commandExists } from "@/server/process";

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
