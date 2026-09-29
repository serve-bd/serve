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

const CLOUDFLARE_RANGES = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];

function ipToInt(ip: string) {
  return ip.split(".").reduce((acc, p) => (acc << 8) + Number(p), 0) >>> 0;
}

export function isCloudflareIp(ip: string) {
  const n = ipToInt(ip);
  return CLOUDFLARE_RANGES.some((cidr) => {
    const [base, bits] = cidr.split("/");
    const mask = bits === "0" ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (n & mask) === (ipToInt(base) & mask);
  });
}

export type DnsStatus = "ok" | "proxied" | "wrong" | "missing" | "unknown";

export async function domainDnsStatus(hostname: string, serverIp: string | null, opts: { tunnel?: boolean } = {}) {
  if (hostname.endsWith(".sslip.io") || hostname.endsWith(".nip.io")) return { status: "ok" as DnsStatus, records: [] as string[] };
  const records = await resolveA(hostname);
  if (!records.length) return { status: "missing" as DnsStatus, records };
  if (serverIp && records.includes(serverIp)) return { status: "ok" as DnsStatus, records };
  // Tunnel domains always resolve to Cloudflare's edge; that is the correct setup for them.
  if (opts.tunnel && records.every(isCloudflareIp)) return { status: "ok" as DnsStatus, records };
  if (records.every(isCloudflareIp)) return { status: "proxied" as DnsStatus, records };
  return { status: (serverIp ? "wrong" : "unknown") as DnsStatus, records };
}
