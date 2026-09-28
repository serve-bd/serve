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

/** Resolve A records through public DNS over HTTPS (avoids local resolver caching). */
export async function resolveA(hostname: string): Promise<string[]> {
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(5000),
    });
    const json = (await res.json()) as { Answer?: { type: number; data: string }[] };
    return (json.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
  } catch {
    return [];
  }
}
