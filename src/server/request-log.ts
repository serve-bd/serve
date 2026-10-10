import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import type { AccessEntry } from "@/server/analytics";
import { parseCopyKey } from "@/server/mesh/plan";
import { REQUEST_LOG_DEFAULTS, type RequestLogConfig, type StatusGroup } from "@/server/services/types";

/*
 * The request log: single requests through the proxy, for services that turned it on (Settings →
 * Monitoring). Read from the same access log as the request counts, filtered by status group, and
 * deleted after the days the service keeps them.
 */

/** The fields kept per request are cut to these lengths: a log line must never grow a row without bound. */
const MAX_PATH = 2048;
const MAX_TEXT = 512;
/** Rows per INSERT, and per DELETE while pruning (short statements, no long locks). */
const BATCH = 500;
const PRUNE_BATCH = 10_000;

export type LogTarget = { serviceId: string; projectId: string; orgId: string; config: RequestLogConfig };

/** A saved config in canonical form: unknown or missing parts fall back to the defaults. */
export function requestLogConfig(raw: Partial<RequestLogConfig> | null | undefined): RequestLogConfig {
  const statuses = Array.isArray(raw?.statuses) ? ([...new Set(raw.statuses)].filter((s) => s >= 2 && s <= 5).sort() as StatusGroup[]) : REQUEST_LOG_DEFAULTS.statuses;
  const days = Number.isInteger(raw?.days) && raw!.days! >= 1 ? raw!.days! : REQUEST_LOG_DEFAULTS.days;
  return { enabled: raw?.enabled === true, days, statuses, ips: raw?.ips ?? REQUEST_LOG_DEFAULTS.ips };
}

/**
 * Hostnames whose requests are logged, with their service. A preview uses its parent's settings
 * (it has none of its own). Wildcard domains ("*.example.com") match one label below them.
 */
export async function logTargets(): Promise<Map<string, LogTarget | null>> {
  const parent = schema.service;
  const rows = await db
    .select({
      hostname: schema.domain.hostname,
      serviceId: schema.service.id,
      projectId: schema.service.projectId,
      orgId: schema.project.organizationId,
      own: schema.service.requestLog,
      parentId: schema.service.parentServiceId,
    })
    .from(schema.domain)
    .innerJoin(schema.service, eq(schema.service.id, schema.domain.serviceId))
    .innerJoin(schema.project, eq(schema.project.id, schema.service.projectId));
  const parentIds = [...new Set(rows.map((r) => r.parentId).filter((x): x is string => !!x))];
  const parents = parentIds.length
    ? new Map((await db.select({ id: parent.id, requestLog: parent.requestLog }).from(parent).where(inArray(parent.id, parentIds))).map((p) => [p.id, p.requestLog]))
    : new Map();
  // Every domain is in the map, also those of services that keep no log (as null): a host that is
  // some service's own domain must never fall to another service's wildcard (*.example.com).
  const out = new Map<string, LogTarget | null>();
  for (const r of rows) {
    const config = requestLogConfig(r.parentId ? parents.get(r.parentId) : r.own);
    const on = config.enabled && config.statuses.length > 0;
    out.set(r.hostname.toLowerCase(), on ? { serviceId: r.serviceId, projectId: r.projectId, orgId: r.orgId, config } : null);
  }
  return out;
}

/**
 * The service whose log keeps a request to this host: the domain's own service, else the wildcard
 * one label up, but only when no service has the host as a domain of its own.
 */
export function targetFor(targets: Map<string, LogTarget | null>, host: string) {
  const h = host.toLowerCase();
  if (targets.has(h)) return targets.get(h) ?? undefined;
  const dot = h.indexOf(".");
  return dot > 0 ? (targets.get(`*${h.slice(dot)}`) ?? undefined) : undefined;
}

const clean = (v: string | undefined, max: number) => (v && v !== "-" ? v.slice(0, max) : null);

export type RequestRow = typeof schema.requestLog.$inferInsert;

/** The row to keep for one access log entry, or null when the service does not keep it. */
export function requestRow(entry: AccessEntry, target: LogTarget, serverId: string): RequestRow | null {
  const group = Math.floor(entry.s / 100);
  if (!target.config.statuses.includes(group as StatusGroup)) return null;
  const time = new Date(entry.t);
  if (Number.isNaN(time.getTime())) return null;
  const uri = entry.u ?? "/";
  const q = uri.indexOf("?");
  return {
    serviceId: target.serviceId,
    time,
    hostname: entry.h.toLowerCase().slice(0, 255),
    method: clean(entry.m, 16),
    path: (q === -1 ? uri : uri.slice(0, q)).slice(0, MAX_PATH) || "/",
    query: q !== -1 && q < uri.length - 1,
    status: entry.s,
    durationMs: Math.max(0, Math.round((entry.rt || 0) * 1000)),
    bytes: Math.max(0, entry.b || 0),
    ip: target.config.ips ? clean(entry.ip, 64) : null,
    userAgent: clean(entry.ua, MAX_TEXT),
    // Like the path: no query or fragment (a reset or sign-in link's token would be kept otherwise).
    referer: clean(entry.ref?.replace(/[?#].*$/, ""), MAX_TEXT),
    // nginx lists every upstream it tried ("a:80, b:80"); the last one answered. Serve's error pages
    // (which replace a 5xx page) are not where the request went.
    upstream: clean(
      entry.up
        ?.split(",")
        .map((u) => u.trim())
        .filter((u) => u && !u.startsWith("serve-proxy-pages:"))
        .at(-1),
      255,
    ),
    serverId,
  };
}

/** Save rows and tell open request lists (live, one event per service). */
export async function saveRequests(rows: RequestRow[], targets: Map<string, LogTarget | null>) {
  for (let i = 0; i < rows.length; i += BATCH) await db.insert(schema.requestLog).values(rows.slice(i, i + BATCH));
  const services = new Set(rows.map((r) => r.serviceId));
  for (const target of new Map([...targets.values()].filter((t): t is LogTarget => !!t).map((t) => [t.serviceId, t])).values()) {
    if (!services.has(target.serviceId)) continue;
    // Not a table trigger: one notice per batch, and LiveUpdates hands it to the request list only.
    await db.execute(
      sql`SELECT pg_notify('serve_events', ${JSON.stringify({ t: "request", op: "INSERT", org: target.orgId, project: target.projectId, service: target.serviceId })})`,
    );
  }
}

/** Delete requests older than each service keeps them (also while the log is off: what was kept still expires). */
export async function pruneRequestLog() {
  const services = await db.select({ id: schema.service.id, requestLog: schema.service.requestLog }).from(schema.service).where(isNotNull(schema.service.requestLog));
  // Previews keep what their parent keeps.
  const days = new Map(services.map((s) => [s.id, requestLogConfig(s.requestLog).days]));
  const withRows = await db
    .selectDistinct({ serviceId: schema.requestLog.serviceId, parentId: schema.service.parentServiceId })
    .from(schema.requestLog)
    .innerJoin(schema.service, eq(schema.service.id, schema.requestLog.serviceId));
  let deleted = 0;
  for (const s of withRows) {
    const keep = days.get(s.parentId ?? s.serviceId) ?? REQUEST_LOG_DEFAULTS.days;
    const before = new Date(Date.now() - keep * 86_400_000);
    for (;;) {
      const r = await db.execute(sql`
        DELETE FROM request_log WHERE id IN (
          SELECT id FROM request_log WHERE service_id = ${s.serviceId} AND time < ${before.toISOString()}::timestamptz LIMIT ${PRUNE_BATCH}
        )`);
      const n = Number((r as unknown as { count?: number }).count ?? 0);
      deleted += n;
      if (n < PRUNE_BATCH) break;
    }
  }
  return deleted;
}

/** Delete every kept request of a service. */
export async function clearRequestLog(serviceId: string) {
  for (;;) {
    const r = await db.execute(sql`DELETE FROM request_log WHERE id IN (SELECT id FROM request_log WHERE service_id = ${serviceId} LIMIT ${PRUNE_BATCH})`);
    if (Number((r as unknown as { count?: number }).count ?? 0) < PRUNE_BATCH) break;
  }
}

export type RequestFilter = {
  /** Status groups to show; empty shows all. */
  statuses?: StatusGroup[];
  /** Path contains (case-insensitive). */
  path?: string;
  method?: string;
  from?: Date;
  to?: Date;
  /** Older than this row (paging, newest first). */
  before?: { time: Date; id: number };
  limit?: number;
};

/** Kept requests of a service, newest first. */
export async function listRequests(serviceId: string, f: RequestFilter = {}) {
  const t = schema.requestLog;
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const where = [eq(t.serviceId, serviceId)];
  const groups = (f.statuses ?? []).map(Number).filter((n) => Number.isInteger(n) && n >= 2 && n <= 5);
  if (groups.length) where.push(inArray(sql`(${t.status} / 100)`, groups));
  if (f.path) where.push(sql`${t.path} ILIKE ${`%${f.path.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`);
  if (f.method) where.push(eq(t.method, f.method.toUpperCase()));
  if (f.from) where.push(sql`${t.time} >= ${f.from.toISOString()}::timestamptz`);
  if (f.to) where.push(lt(t.time, f.to));
  if (f.before) where.push(sql`(${t.time}, ${t.id}) < (${f.before.time.toISOString()}::timestamptz, ${f.before.id})`);
  const rows = await db
    .select()
    .from(t)
    .where(and(...where))
    .orderBy(sql`${t.time} DESC, ${t.id} DESC`)
    .limit(limit + 1);
  return { requests: rows.slice(0, limit), more: rows.length > limit };
}

/**
 * Which server (and replica on another server) answered a request, from the upstream the proxy
 * logged: a copy on another server is reached through its private address (a link container
 * "serve-link-<ip>", or the address itself); anything else ran on the server whose proxy logged it.
 */
export async function answeredBy(rows: { upstream: string | null; serverId: string | null }[]) {
  const ipOf = (up: string | null) => {
    if (!up) return null;
    const link = up.match(/serve-link-(\d+)-(\d+)-(\d+)-(\d+)/);
    if (link) return link.slice(1).join(".");
    const ip = up.match(/^(10\.24[01]\.\d+\.\d+)(?::\d+)?$/);
    return ip ? ip[1] : null;
  };
  const ips = [...new Set(rows.map((r) => ipOf(r.upstream)).filter((x): x is string => !!x))];
  const addresses = ips.length
    ? await db.select({ ip: schema.meshAddress.ip, key: schema.meshAddress.key }).from(schema.meshAddress).where(inArray(schema.meshAddress.ip, ips))
    : [];
  const copies = new Map(addresses.map((a) => [a.ip, parseCopyKey(a.key)]));
  const serverIds = [...new Set([...rows.map((r) => r.serverId), ...[...copies.values()].map((c) => c?.serverId)].filter((x): x is string => !!x))];
  const names = new Map(
    serverIds.length
      ? (await db.select({ id: schema.server.id, name: schema.server.name }).from(schema.server).where(inArray(schema.server.id, serverIds))).map((s) => [s.id, s.name])
      : [],
  );
  return rows.map((r) => {
    const ip = ipOf(r.upstream);
    const copy = ip ? copies.get(ip) : null;
    if (copy) return `${names.get(copy.serverId) ?? "Another server"}, replica ${copy.slot}`;
    const server = r.serverId ? (names.get(r.serverId) ?? null) : null;
    // A replica on the logging server: its container is named "<slug>-<deployment>-<number>".
    const local = r.upstream?.match(/-[a-z0-9]{6}-(\d+):\d+$/);
    return server && local ? `${server}, replica ${local[1]}` : server;
  });
}

/** One page of the request log, as the dashboard and the API show it. */
export async function requestLogPage(serviceId: string, f: RequestFilter) {
  const { requests, more } = await listRequests(serviceId, f);
  const by = await answeredBy(requests);
  const last = requests.at(-1);
  return {
    requests: requests.map((r, i) => ({
      id: r.id,
      time: r.time.toISOString(),
      hostname: r.hostname,
      method: r.method,
      path: r.path,
      query: r.query,
      status: r.status,
      durationMs: r.durationMs,
      bytes: r.bytes,
      ip: r.ip,
      userAgent: r.userAgent,
      referer: r.referer,
      answeredBy: by[i],
    })),
    /** Pass as `before` for the next page; null when there is none. */
    next: more && last ? `${last.time.toISOString()}_${last.id}` : null,
  };
}

/** A `before` cursor from requestLogPage, or null when it is malformed. */
export function parseCursor(raw: string | null | undefined) {
  const m = raw?.match(/^(.+)_(\d+)$/);
  if (!m) return null;
  const time = new Date(m[1]);
  return Number.isNaN(time.getTime()) ? null : { time, id: Number(m[2]) };
}

/** Request log filters from query parameters (dashboard and API). */
export function filterFromQuery(q: URLSearchParams): RequestFilter {
  const date = (v: string | null) => {
    if (!v) return undefined;
    const d = /^\d+$/.test(v) ? new Date(Number(v) * (v.length > 11 ? 1 : 1000)) : new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  const statuses = (q.get("status") ?? "")
    .split(",")
    .map((s) => Number(s.trim().replace(/xx$/i, "")))
    .filter((n) => n >= 2 && n <= 5) as StatusGroup[];
  return {
    statuses,
    path: q.get("path")?.trim() || undefined,
    method: q.get("method")?.trim() || undefined,
    from: date(q.get("from")),
    to: date(q.get("to")),
    before: parseCursor(q.get("before")) ?? undefined,
    limit: Number(q.get("limit")) || undefined,
  };
}
