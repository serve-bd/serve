import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { execInContainer } from "@/server/docker/client";
import { statusMatcher } from "@/server/deploy/options";
import { getServer } from "@/server/servers/context";
import { appCopies, nextBalance } from "./balance";
import { copyId, decide, probePath, RESYNC_MS, SYNC_RETRY_MS, step, type Streak, targetsSignature } from "./balance-rules";

export { CHECK_INTERVAL_MS } from "./balance-rules";

/*
 * Health checks of the copies an app runs on its extra servers, made by the worker every few
 * seconds from inside the proxy of the app's own server: the same path visitors take (link
 * container, private network, the copy's server). A copy is taken out of the load balancing after
 * two failed checks in a row and put back after two good ones, so one lost packet does not move
 * traffic around; a copy not checked yet counts as up (the proxy's own retries cover it).
 */

const streaks = new Map<string, Streak>();
/** The targets each app's proxy was last synced with, and when, to sync again when they change. */
const synced = new Map<string, { sig: string; at: number }>();
/** When a failed proxy sync may be tried again. */
const retryAt = new Map<string, number>();

/** How many apps of one server are checked at the same time. */
const PARALLEL = 8;

type Row = typeof schema.service.$inferSelect;

/** One check of a copy from the proxy container of the app's own server. */
async function probe(
  proxy: { container: string; docker: Parameters<typeof execInContainer>[3] },
  host: string,
  service: Row,
  port: number,
): Promise<{ ok: boolean; error: string | null }> {
  const rt = service.runtime;
  const path = probePath(rt.healthcheckPath);
  // No shell: the path comes from the service's settings and must never be run as code.
  const cmd = path ? ["wget", "-S", "-q", "-T", "3", "-O", "/dev/null", `http://${host}:${port}${path}`] : ["nc", "-z", "-w", "2", host, String(port)];
  try {
    const res = await Promise.race([
      execInContainer(proxy.container, cmd, {}, proxy.docker),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 4500).unref()),
    ]);
    if (!path) return res.exitCode === 0 ? { ok: true, error: null } : { ok: false, error: `Nothing answers on port ${port}.` };
    const statuses = [...res.output.matchAll(/HTTP\/[\d.]+\s+(\d{3})/g)].map((m) => Number(m[1]));
    const status = statuses.at(-1) ?? 0;
    const accept = rt.healthcheckStatus ? statusMatcher(rt.healthcheckStatus) : (s: number) => s > 0 && s < 500;
    if (accept(status)) return { ok: true, error: null };
    return { ok: false, error: status ? `${path} answered ${status}.` : `${path} did not answer on port ${port}.` };
  } catch (error) {
    // The proxy itself is not running: nothing to say about the copy (the proxy check reports that).
    if (/No such container|is not running|409/i.test((error as Error).message)) throw error;
    return { ok: false, error: `No answer on port ${port} within a few seconds.` };
  }
}

/** Runs fn over items, at most `limit` at a time. */
async function limited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

/** Check every copy of every load-balanced app, save changes in health and sync the proxies whose targets changed. */
export async function checkBalances(log: (...args: unknown[]) => void = () => {}) {
  const candidates = await db
    .select()
    .from(schema.service)
    .where(
      and(
        eq(schema.service.type, "app"),
        isNotNull(schema.service.currentDeploymentId),
        sql`${schema.service.distribution}->>'loadBalance' = 'true'`,
        sql`jsonb_array_length(coalesce(${schema.service.distribution}->'extraServerIds', '[]'::jsonb)) > 0`,
      ),
    );
  // Only apps visitors reach through the proxy: without a domain there is nothing to balance.
  const domains = candidates.length
    ? await db
        .select({ serviceId: schema.domain.serviceId, port: schema.domain.port })
        .from(schema.domain)
        .where(
          inArray(
            schema.domain.serviceId,
            candidates.map((r) => r.id),
          ),
        )
    : [];
  const rows = candidates.filter((r) => domains.some((d) => d.serviceId === r.id));
  const live = new Set(rows.map((r) => r.id));
  for (const key of [...synced.keys()]) if (!live.has(key)) synced.delete(key);
  for (const key of [...retryAt.keys()]) if (!live.has(key)) retryAt.delete(key);
  for (const key of [...streaks.keys()]) if (!live.has(key.split("|")[0])) streaks.delete(key);

  const byServer = new Map<string, Row[]>();
  for (const r of rows) byServer.set(r.serverId, [...(byServer.get(r.serverId) ?? []), r]);
  // Only servers whose proxy can balance: ready (or the dashboard's own machine) and running a proxy.
  const servers = byServer.size
    ? await db
        .select({ id: schema.server.id, isLocal: schema.server.isLocal, status: schema.server.status, proxyKind: schema.server.proxyKind })
        .from(schema.server)
        .where(inArray(schema.server.id, [...byServer.keys()]))
    : [];
  const able = new Set(servers.filter((s) => (s.isLocal || s.status === "ready") && s.proxyKind !== "none").map((s) => s.id));

  await Promise.all(
    [...byServer].map(async ([serverId, services]) => {
      if (!able.has(serverId)) return;
      const ctx = await getServer(serverId).catch(() => null);
      if (!ctx) return;
      await limited(services, PARALLEL, async (service) => {
        try {
          let copies = await appCopies(service);
          const now = new Date();
          let state = service.balance;
          let changed = false;
          // The port visitors are sent to (the first domain's, else the app's), unless a health check port is set.
          const port = service.runtime.healthcheckPort || domains.find((d) => d.serviceId === service.id && d.port)?.port || service.runtime.port;
          if (service.status !== "stopped" && port) {
            // Every replica at once: one that does not answer must not delay the others' checks.
            const usable = copies.filter((c) => c.linked && c.host && c.deployed);
            for (const c of copies) if (!usable.includes(c)) streaks.delete(`${service.id}|${copyId(c.serverId, c.slot)}`);
            const results = await Promise.all(usable.map((c) => probe({ container: ctx.proxyContainer, docker: ctx.docker }, c.host!, service, port)));
            usable.forEach((c, i) => {
              const result = results[i];
              const id = copyId(c.serverId, c.slot);
              const key = `${service.id}|${id}`;
              const streak = step(streaks.get(key), result.ok);
              streaks.set(key, streak);
              const verdict = decide(state?.copies?.[id]?.ok ?? null, streak);
              if (verdict === null) return;
              const next = nextBalance(state, id, verdict, verdict ? null : result.error, now);
              if (next) {
                log(`load balancing: ${service.name} replica ${c.slot} on ${c.serverId} is ${verdict ? "up" : `down (${result.error})`}`);
                state = next;
                changed = true;
              }
            });
          }
          // Replicas that no longer exist (fewer replicas, a server removed) are forgotten.
          const ids = new Set(copies.map((c) => copyId(c.serverId, c.slot)));
          const stale = Object.keys(state?.copies ?? {}).filter((k) => !ids.has(k));
          if (stale.length && state) {
            state = { copies: Object.fromEntries(Object.entries(state.copies).filter(([k]) => ids.has(k))) };
            changed = true;
          }
          if (changed) {
            await db.update(schema.service).set({ balance: state }).where(eq(schema.service.id, service.id));
            copies = await appCopies({ ...service, balance: state });
          }
          const sig = targetsSignature(copies);
          const last = synced.get(service.id);
          const due = !last || last.sig !== sig || Date.now() - last.at > RESYNC_MS;
          if (due && (retryAt.get(service.id) ?? 0) <= Date.now()) {
            // The app may have moved to another server since it was read: its new server's proxy is synced by the move.
            const [fresh] = await db.select({ serverId: schema.service.serverId }).from(schema.service).where(eq(schema.service.id, service.id));
            if (fresh?.serverId !== serverId) return;
            const { syncServiceProxy } = await import("@/server/proxy/nginx");
            try {
              await syncServiceProxy(service.id, serverId);
              synced.set(service.id, { sig, at: Date.now() });
              retryAt.delete(service.id);
            } catch (error) {
              retryAt.set(service.id, Date.now() + SYNC_RETRY_MS);
              throw error;
            }
          }
        } catch (error) {
          // The proxy is not running (being switched or rebuilt): check again next time, quietly.
          if (/No such container|is not running|409/i.test((error as Error).message)) return;
          log(`load balancing: ${service.name}: ${(error as Error).message}`);
        }
      });
    }),
  );
}
