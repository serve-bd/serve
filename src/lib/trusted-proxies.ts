import { z } from "zod";

/**
 * Trusted proxies of a server: a CDN or load balancer in front of it whose visitor IP header
 * the proxy believes. Off (null on the server row) trusts only Cloudflare Tunnel traffic.
 */
export const CLIENT_IP_HEADERS = ["x-forwarded-for", "x-real-ip", "cf-connecting-ip", "true-client-ip", "proxy-protocol"] as const;
export type ClientIpHeader = (typeof CLIENT_IP_HEADERS)[number];

export const clientIpHeaderNames: Record<ClientIpHeader, string> = {
  "x-forwarded-for": "X-Forwarded-For",
  "x-real-ip": "X-Real-IP",
  "cf-connecting-ip": "CF-Connecting-IP",
  "true-client-ip": "True-Client-IP",
  "proxy-protocol": "PROXY protocol",
};

/**
 * PROXY protocol: the proxy in front opens each connection with the visitor's address (v1 or v2)
 * instead of setting a header. It works for TLS it passes through unchanged, where no header can
 * be added. Only connections from the trusted ranges may send it.
 */
export const usesProxyProtocol = (v: Pick<VisitorIp, "header">) => v.header === "proxy-protocol";

export type TrustedProxies = {
  /** Normalized CIDR ranges (single addresses as /32 or /128). */
  ranges: string[];
  header: ClientIpHeader;
  /** Also trust Cloudflare's published ranges (its proxy, not the tunnel). */
  cloudflare: boolean;
  /** Also trust a proxy on the machine itself, like a system nginx that owns ports 80 and 443. */
  machine?: boolean;
};

/**
 * Who a server's proxy believes about the visitor IP. `tunnel`: the network only cloudflared
 * shares with the proxy (always trusted, for CF-Connecting-IP). `ranges` and `header` are set
 * when trusted proxies are on; header null keeps the tunnel-only behaviour.
 */
export type VisitorIp = { tunnel: string[]; ranges: string[]; header: ClientIpHeader | null };

export const allTrusted = (v: VisitorIp) => [...new Set([...v.tunnel, ...v.ranges])];

/**
 * Sources whose X-Forwarded-For is believed. With PROXY protocol the trusted ranges vouch for the
 * connection, not for headers: a visitor's own X-Forwarded-For passes through them unchanged.
 */
export const headerTrusted = (v: VisitorIp) => (usesProxyProtocol(v) ? v.tunnel : allTrusted(v));

export const MAX_TRUSTED_RANGES = 100;
/** Shorter prefixes cover so much of the internet that anyone could claim any visitor IP. */
const MIN_PREFIX = { 4: 8, 6: 16 } as const;

type Parsed = { version: 4 | 6; bits: bigint; prefix: number };

function parseV4(value: string): bigint | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let out = BigInt(0);
  for (const p of parts) {
    // No leading zeros: some tools read 010 as octal.
    if (!/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255) return null;
    out = (out << BigInt(8)) | BigInt(p);
  }
  return out;
}

function parseV6(value: string): bigint | null {
  if (!/^[0-9a-f:.]+$/i.test(value) || value.split("::").length > 2) return null;
  let tail: bigint[] = [];
  let text = value;
  // An IPv4 address at the end (::ffff:192.0.2.1) fills the last two groups.
  const v4 = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const n = parseV4(v4[1]);
    if (n === null) return null;
    tail = [n >> BigInt(16), n & BigInt(0xffff)];
    text = text.slice(0, -v4[1].length);
    if (!text.endsWith("::")) text = text.slice(0, -1);
  }
  const group = (g: string) => (/^[0-9a-f]{1,4}$/i.test(g) ? BigInt(`0x${g}`) : null);
  const [head, rest] = text.split("::");
  const left = head ? head.split(":").map(group) : [];
  const right = rest !== undefined && rest ? rest.split(":").map(group) : [];
  if ([...left, ...right].some((g) => g === null)) return null;
  const known = left.length + right.length + tail.length;
  if (rest === undefined ? known !== 8 : known > 7) return null;
  const groups = [...(left as bigint[]), ...Array(8 - known).fill(BigInt(0)), ...(right as bigint[]), ...tail];
  return groups.reduce((acc, g) => (acc << BigInt(16)) | g, BigInt(0));
}

function parseAddress(value: string): { version: 4 | 6; bits: bigint } | null {
  if (value.includes(":")) {
    const bits = parseV6(value);
    return bits === null ? null : { version: 6, bits };
  }
  const bits = parseV4(value);
  return bits === null ? null : { version: 4, bits };
}

const width = (version: 4 | 6) => (version === 4 ? 32 : 128);
const mask = (version: 4 | 6, prefix: number) => ((BigInt(1) << BigInt(width(version))) - BigInt(1)) ^ ((BigInt(1) << BigInt(width(version) - prefix)) - BigInt(1));

function parseRange(value: string): Parsed | null {
  const [addr, prefixText, extra] = value.split("/");
  if (extra !== undefined || !addr) return null;
  const ip = parseAddress(addr);
  if (!ip) return null;
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = prefixText === undefined ? width(ip.version) : Number(prefixText);
  if (prefix > width(ip.version)) return null;
  return { version: ip.version, bits: ip.bits & mask(ip.version, prefix), prefix };
}

function formatV6(bits: bigint) {
  const groups = Array.from({ length: 8 }, (_, i) => Number((bits >> BigInt((7 - i) * 16)) & BigInt(0xffff)));
  // RFC 5952: the longest run of two or more zero groups becomes "::".
  let best = { start: -1, length: 0 };
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > best.length && j - i > 1) best = { start: i, length: j - i };
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best.start < 0) return hex.join(":");
  return `${hex.slice(0, best.start).join(":")}::${hex.slice(best.start + best.length).join(":")}`;
}

function formatAddress(version: 4 | 6, bits: bigint) {
  if (version === 6) return formatV6(bits);
  return [24, 16, 8, 0].map((shift) => String((bits >> BigInt(shift)) & BigInt(0xff))).join(".");
}

const format = (r: Parsed) => `${formatAddress(r.version, r.bits)}/${r.prefix}`;

/** A trusted range in canonical form (network address, explicit prefix), or why it cannot be trusted. */
export function normalizeTrustedRange(input: string): { range: string } | { error: string } {
  const value = input.trim();
  const r = parseRange(value);
  if (!r) return { error: `${value} is not an IP address or CIDR range (like 203.0.113.0/24 or 2001:db8::/32).` };
  if (r.prefix < MIN_PREFIX[r.version]) {
    return { error: `${value} is too wide. Visitors could fake their IP. Use a range of /${MIN_PREFIX[r.version]} or narrower.` };
  }
  return { range: format(r) };
}

/** Normalized, de-duplicated ranges from a list (blank lines ignored), or the first problem. */
export function normalizeTrustedRanges(list: string[]): { ranges: string[] } | { error: string } {
  const out: string[] = [];
  for (const line of list) {
    if (!line.trim()) continue;
    const r = normalizeTrustedRange(line);
    if ("error" in r) return r;
    if (!out.includes(r.range)) out.push(r.range);
  }
  if (out.length > MAX_TRUSTED_RANGES) return { error: `List at most ${MAX_TRUSTED_RANGES} ranges.` };
  return { ranges: out };
}

export const trustedProxiesSchema = z
  .object({
    ranges: z.array(z.string().max(100)).max(MAX_TRUSTED_RANGES * 2),
    header: z.enum(CLIENT_IP_HEADERS),
    cloudflare: z.boolean(),
    machine: z.boolean().optional(),
  })
  .transform((v, ctx): TrustedProxies => {
    const r = normalizeTrustedRanges(v.ranges);
    if ("error" in r) {
      ctx.addIssue({ code: "custom", message: r.error, path: ["ranges"] });
      return z.NEVER;
    }
    if (v.header === "proxy-protocol" && v.cloudflare) {
      ctx.addIssue({ code: "custom", message: "Cloudflare's proxy does not send PROXY protocol. Choose a header for Cloudflare.", path: ["cloudflare"] });
      return z.NEVER;
    }
    if (!r.ranges.length && !v.cloudflare && !v.machine) {
      ctx.addIssue({ code: "custom", message: "Add the IP ranges of your proxy, or choose Cloudflare or a proxy on this machine.", path: ["ranges"] });
      return z.NEVER;
    }
    return { ranges: r.ranges, header: v.header, cloudflare: v.cloudflare, ...(v.machine ? { machine: true } : {}) };
  });

/** An address from a header entry ("192.0.2.1:443", "[2001:db8::1]:443", "::ffff:192.0.2.1"), or null. */
function entryAddress(entry: string) {
  let v = entry.trim();
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (bracket) v = bracket[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(":"));
  const ip = parseAddress(v);
  if (!ip) return null;
  // IPv4-mapped IPv6 counts as the IPv4 address.
  if (ip.version === 6 && ip.bits >> BigInt(32) === BigInt(0xffff)) {
    const bits = ip.bits & BigInt(0xffffffff);
    return { version: 4 as const, bits, text: formatAddress(4, bits) };
  }
  return { ...ip, text: formatAddress(ip.version, ip.bits) };
}

/** Whether an address falls in any of the ranges (addresses or CIDRs). */
export function inRanges(address: string, ranges: string[]) {
  const ip = entryAddress(address);
  if (!ip) return false;
  return ranges.some((range) => {
    const r = parseRange(range.trim());
    return !!r && r.version === ip.version && (ip.bits & mask(r.version, r.prefix)) === r.bits;
  });
}

/**
 * The visitor's address from X-Forwarded-For: the right-most entry that is not a trusted proxy.
 * The right-most entry was added by Serve's own proxy; each trusted hop vouches for the entry
 * to its left, anything further left is the visitor's own claim.
 */
export function clientIpFrom(forwarded: string | null | undefined, trusted: string[]) {
  const entries = (forwarded ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  for (let i = entries.length - 1; i >= 0; i--) {
    const ip = entryAddress(entries[i]);
    // Garbage means the hop to its right did not write it: stop at the last good address.
    if (!ip) return i < entries.length - 1 ? (entryAddress(entries[i + 1])?.text ?? null) : null;
    if (i === 0 || !inRanges(ip.text, trusted)) return ip.text;
  }
  return null;
}
