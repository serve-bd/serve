import fs from "node:fs/promises";
import path from "node:path";
import { sql as dsql } from "drizzle-orm";
import { db } from "@/server/db";
import { sh } from "@/server/servers/ssh";
import type { ServerCtx } from "@/server/servers/context";
import { activeServers } from "@/server/proxy/nginx";

const MAX_LOG_SIZE = 64 * 1024 * 1024;
const CHUNK = 16 * 1024 * 1024;
/** Read position in each server's access log. Unknown servers start at the end. */
const offsets = new Map<string, number>();

type Bucket = { requests: number; s2: number; s3: number; s4: number; s5: number; bytes: number; ms: number; max: number };

/** Read new access log lines from every proxy and fold them into per-minute counters. */
export async function ingestAccessLog() {
  let total = 0;
  for (const ctx of await activeServers()) {
    try {
      total += await ingestServerLog(ctx);
    } catch {
      // unreachable server: try again next round from the same offset
    }
  }
  return total;
}

async function ingestServerLog(ctx: ServerCtx) {
  const file = path.posix.join(ctx.paths.proxyLogs, "access.log");
  const stat = await ctx.fs.stat(file);
  if (!stat) return 0;
  let offset = offsets.get(ctx.id);
  if (offset === undefined || offset > stat.size) offset = offset === undefined ? stat.size : 0; // start at the end on boot
  offsets.set(ctx.id, offset);
  if (stat.size === offset) return 0;

  const buffer = await ctx.fs.readFrom(file, offset, Math.min(stat.size - offset, CHUNK));
  const text = buffer.toString("utf8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) return 0;
  offset += Buffer.byteLength(text.slice(0, lastNewline + 1));
  offsets.set(ctx.id, offset);

  const buckets = new Map<string, Bucket>();
  let count = 0;
  for (const line of text.slice(0, lastNewline).split("\n")) {
    if (!line) continue;
    const entry = normalizeAccessLine(line);
    if (!entry) continue;
    if (!entry.h || entry.h === "_" || entry.u?.startsWith("/.well-known/acme-challenge/") || entry.u === "/__serve/health") continue;
    const minute = new Date(entry.t);
    if (Number.isNaN(minute.getTime())) continue;
    minute.setSeconds(0, 0);
    const key = `${entry.h.toLowerCase()}|${minute.toISOString()}`;
    const b = buckets.get(key) ?? { requests: 0, s2: 0, s3: 0, s4: 0, s5: 0, bytes: 0, ms: 0, max: 0 };
    b.requests++;
    const s = Math.floor(entry.s / 100);
    if (s === 2) b.s2++;
    else if (s === 3) b.s3++;
    else if (s === 4) b.s4++;
    else if (s === 5) b.s5++;
    b.bytes += entry.b || 0;
    const ms = Math.round((entry.rt || 0) * 1000);
    b.ms += ms;
    b.max = Math.max(b.max, ms);
    buckets.set(key, b);
    count++;
  }

  for (const [key, b] of buckets) {
    const [hostname, minute] = key.split("|");
    await db.execute(dsql`
      INSERT INTO request_metric (hostname, minute, requests, s2xx, s3xx, s4xx, s5xx, bytes, duration_ms, max_ms)
      VALUES (${hostname}, ${minute}::timestamptz, ${b.requests}, ${b.s2}, ${b.s3}, ${b.s4}, ${b.s5}, ${b.bytes}, ${b.ms}, ${b.max})
      ON CONFLICT (hostname, minute) DO UPDATE SET
        requests = request_metric.requests + excluded.requests,
        s2xx = request_metric.s2xx + excluded.s2xx,
        s3xx = request_metric.s3xx + excluded.s3xx,
        s4xx = request_metric.s4xx + excluded.s4xx,
        s5xx = request_metric.s5xx + excluded.s5xx,
        bytes = request_metric.bytes + excluded.bytes,
        duration_ms = request_metric.duration_ms + excluded.duration_ms,
        max_ms = GREATEST(request_metric.max_ms, excluded.max_ms)
    `);
  }

  // Keep the log small; nginx appends, so truncating in place is safe.
  if (stat.size > MAX_LOG_SIZE && offset >= stat.size) {
    try {
      if (ctx.local) await fs.truncate(file, 0);
      else {
        const r = await ctx.exec(`truncate -s 0 ${sh(file)} || : > ${sh(file)}`);
        if (r.code !== 0) throw new Error(r.stderr);
      }
      offsets.set(ctx.id, 0);
    } catch {
      // not writable (e.g. dev worker without root); keep reading
    }
  }
  return count;
}

export type AccessEntry = { t: string; h: string; s: number; b: number; rt: number; u?: string; ip?: string };

/**
 * One access-log line from any proxy, in the fields analytics needs:
 * nginx (Serve's own JSON format), Caddy (JSON access log) or Traefik (JSON access log).
 */
export function normalizeAccessLine(line: string): AccessEntry | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw.h === "string") return raw as unknown as AccessEntry;
  if (raw.request && typeof raw.request === "object") {
    const req = raw.request as { host?: string; uri?: string; client_ip?: string; remote_ip?: string };
    return {
      t: new Date(Number(raw.ts) * 1000).toISOString(),
      h: String(req.host ?? "").replace(/:\d+$/, ""),
      u: req.uri,
      s: Number(raw.status) || 0,
      b: Number(raw.size) || 0,
      rt: Number(raw.duration) || 0,
      ip: req.client_ip ?? req.remote_ip,
    };
  }
  if (typeof raw.RequestHost === "string") {
    return {
      t: String(raw.StartUTC ?? raw.time ?? new Date().toISOString()),
      h: raw.RequestHost.replace(/:\d+$/, ""),
      u: typeof raw.RequestPath === "string" ? raw.RequestPath : undefined,
      s: Number(raw.DownstreamStatus) || 0,
      b: Number(raw.DownstreamContentSize) || 0,
      rt: (Number(raw.Duration) || 0) / 1e9,
      ip: typeof raw.ClientHost === "string" ? raw.ClientHost : undefined,
    };
  }
  return null;
}

export async function pruneRequestMetrics() {
  await db.execute(dsql`DELETE FROM request_metric WHERE minute < now() - interval '30 days'`);
}

export type RequestPoint = { t: number; requests: number; s2xx: number; s3xx: number; s4xx: number; s5xx: number; bytes: number; avgMs: number; maxMs: number };

export async function requestSeries(hostnames: string[], hours = 24, buckets = 96): Promise<RequestPoint[]> {
  if (!hostnames.length) return [];
  const bucketSeconds = Math.max(60, Math.floor((hours * 3600) / buckets));
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = await db.execute<{ t: string; requests: number; s2xx: number; s3xx: number; s4xx: number; s5xx: number; bytes: number; ms: number; max_ms: number }>(dsql`
    SELECT to_timestamp(floor(extract(epoch FROM minute) / ${bucketSeconds}::int) * ${bucketSeconds}::int) AS t,
      sum(requests)::int AS requests, sum(s2xx)::int AS s2xx, sum(s3xx)::int AS s3xx, sum(s4xx)::int AS s4xx, sum(s5xx)::int AS s5xx,
      sum(bytes)::float AS bytes, sum(duration_ms)::float AS ms, max(max_ms)::int AS max_ms
    FROM request_metric
    WHERE hostname = ANY(string_to_array(${hostnames.join(",")}::text, ',')) AND minute >= ${since}::timestamptz
    GROUP BY 1 ORDER BY 1
  `);
  const found = new Map([...rows].map((r) => [new Date(r.t).getTime(), r]));
  const step = bucketSeconds * 1000;
  const end = Math.floor(Date.now() / step) * step;
  const start = end - (Math.ceil((hours * 3600_000) / step) - 1) * step;
  const out: RequestPoint[] = [];
  // Emit every bucket (zeros included) so charts keep a steady time axis.
  for (let t = start; t <= end; t += step) {
    const r = found.get(t);
    out.push(
      r
        ? {
            t,
            requests: Number(r.requests),
            s2xx: Number(r.s2xx),
            s3xx: Number(r.s3xx),
            s4xx: Number(r.s4xx),
            s5xx: Number(r.s5xx),
            bytes: Number(r.bytes),
            avgMs: Number(r.requests) ? Number(r.ms) / Number(r.requests) : 0,
            maxMs: Number(r.max_ms),
          }
        : { t, requests: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, bytes: 0, avgMs: 0, maxMs: 0 },
    );
  }
  return out;
}
