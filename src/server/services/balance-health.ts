import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { execInContainer } from "@/server/docker/client";
import { statusMatcher } from "@/server/deploy/options";
import { getServer } from "@/server/servers/context";
import { appCopies, nextBalance } from "./balance";
import { copyId, decide, step, type Streak, targetsSignature } from "./balance-rules";

export { CHECK_INTERVAL_MS } from "./balance-rules";

/*
 * Health checks of the copies an app runs on its extra servers, made by the worker every few
 * seconds from inside the proxy of the app's own server: the same path visitors take (link
 * container, private network, the copy's server). A copy is taken out of the load balancing after
 * two failed checks in a row and put back after two good ones, so one lost packet does not move
 * traffic around; a copy not checked yet counts as up (the proxy's own retries cover it).
 */

const streaks = new Map<string, Streak>();
/** The targets each app's proxy was last synced with, to sync again when they change. */
const synced = new Map<string, string>();

type Row = typeof schema.service.$inferSelect;

/** One check of a copy from the proxy container of the app's own server. */
async function probe(proxy: { container: string; docker: Parameters<typeof execInContainer>[3] }, host: string, service: Row): Promise<{ ok: boolean; error: string | null }> {
  const rt = service.runtime;
  const port = rt.healthcheckPort || rt.port || 80;
  // No shell: the path comes from the service's settings and must never be run as code.
  const cmd = rt.healthcheckPath ? ["wget", "-S", "-q", "-T", "4", "-O", "/dev/null", `http://${host}:${port}${rt.healthcheckPath}`] : ["nc", "-z", "-w", "3", host, String(port)];
  try {
    const res = await Promise.race([
      execInContainer(proxy.container, cmd, {}, proxy.docker),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000).unref()),
    ]);
    if (!rt.healthcheckPath) return res.exitCode === 0 ? { ok: true, error: null } : { ok: false, error: `Nothing answers on port ${port}.` };
    const statuses = [...res.output.matchAll(/HTTP\/[\d.]+\s+(\d{3})/g)].map((m) => Number(m[1]));
    const status = statuses.at(-1) ?? 0;
    const accept = rt.healthcheckStatus ? statusMatcher(rt.healthcheckStatus) : (s: number) => s > 0 && s < 500;
    if (accept(status)) return { ok: true, error: null };
    return { ok: false, error: status ? `${rt.healthcheckPath} answered ${status}.` : `${rt.healthcheckPath} did not answer on port ${port}.` };
  } catch (error) {
    // The proxy itself is not running: nothing to say about the copy (the proxy check reports that).
    if (/No such container|is not running|409/i.test((error as Error).message)) throw error;
    return { ok: false, error: `No answer on port ${port} within a few seconds.` };
  }
}

/** Check every copy of every load-balanced app, save changes in health and sync the proxies whose targets changed. */
export async function checkBalances(log: (...args: unknown[]) => void = () => {}) {
  const rows = await db
    .select()
    .from(schema.service)
    .where(
      and(
        eq(schema.service.type, "app"),
        isNotNull(schema.service.currentDeploymentId),
        sql`jsonb_array_length(coalesce(${schema.service.distribution}->'extraServerIds', '[]'::jsonb)) > 0`,
      ),
    );
  const live = new Set(rows.map((r) => r.id));
  for (const key of [...synced.keys()]) if (!live.has(key)) synced.delete(key);
  for (const key of [...streaks.keys()]) if (!live.has(key.split("|")[0])) streaks.delete(key);

  const byServer = new Map<string, Row[]>();
  for (const r of rows) byServer.set(r.serverId, [...(byServer.get(r.serverId) ?? []), r]);

  await Promise.all(
    [...byServer].map(async ([serverId, services]) => {
      const ctx = await getServer(serverId).catch(() => null);
      if (!ctx) return;
      for (const service of services) {
        try {
          let copies = await appCopies(service);
          const now = new Date();
          let state = service.balance;
          let changed = false;
          if (service.status !== "stopped") {
            for (const c of copies) {
              const id = copyId(c.serverId, c.slot);
              const key = `${service.id}|${id}`;
              if (!c.linked || !c.host || !c.deployed) {
                streaks.delete(key);
                continue;
              }
              const result = await probe({ container: ctx.proxyContainer, docker: ctx.docker }, c.host, service);
              const streak = step(streaks.get(key), result.ok);
              streaks.set(key, streak);
              const verdict = decide(state?.copies?.[id]?.ok ?? null, streak);
              if (verdict === null) continue;
              const next = nextBalance(state, id, verdict, verdict ? null : result.error, now);
              if (next) {
                if (state?.copies?.[id]?.ok !== verdict) log(`load balancing: ${service.name} replica ${c.slot} on ${c.serverId} is ${verdict ? "up" : `down (${result.error})`}`);
                state = next;
                changed = true;
              }
            }
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
          if (synced.get(service.id) !== sig) {
            const { syncServiceProxy } = await import("@/server/proxy/nginx");
            await syncServiceProxy(service.id, serverId);
            synced.set(service.id, sig);
          }
        } catch (error) {
          log(`load balancing: ${service.name}: ${(error as Error).message}`);
        }
      }
    }),
  );
}
