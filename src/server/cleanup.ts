import { and, eq, inArray, sql as dsql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LABEL, removeContainer } from "@/server/docker/client";
import { getServer, LOCAL_SERVER_ID, type ServerCtx } from "@/server/servers/context";
import { pruneJobs } from "@/server/queue";
import { pruneMetrics, serverSnapshot } from "@/server/metrics";
import { pruneRequestMetrics } from "@/server/analytics";
import { getSettings, updateSettings, type CleanupRun } from "@/server/settings";
import { notify } from "@/server/notify";
import { run } from "@/server/process";

type Trigger = CleanupRun["trigger"];

const UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 };

/** Parses "Total reclaimed space: 1.2GB" (image prune) and "Total: 1.2GB" (builder prune). */
export function parseReclaimed(output: string) {
  const m = output.match(/Total(?: reclaimed space)?:\s*([\d.]+)\s*([kmgt]?b)/i);
  if (!m) return 0;
  return Math.round(Number(m[1]) * (UNITS[m[2].toLowerCase()] ?? 1));
}

async function docker_(ctx: ServerCtx, args: string[]) {
  try {
    return parseReclaimed(await run("docker", args, { env: await ctx.cliEnv() }));
  } catch {
    return 0;
  }
}

/**
 * Stopped Serve containers left behind by older deployments (for example a
 * failed zero-downtime switch). Only touches services this instance knows,
 * never the current deployment, stopped services or services mid-deploy.
 */
async function removeStaleContainers(ctx: ServerCtx) {
  const containers = await ctx.docker.listContainers({ all: true, filters: { label: [`${LABEL.managed}=true`], status: ["exited", "created", "dead"] } });
  const ids = [...new Set(containers.map((c) => c.Labels[LABEL.service]).filter(Boolean))];
  if (!ids.length) return 0;
  const services = await db
    .select()
    .from(schema.service)
    .where(and(inArray(schema.service.id, ids), eq(schema.service.serverId, ctx.id)));
  const busy = await db
    .select({ serviceId: schema.deployment.serviceId })
    .from(schema.deployment)
    .where(inArray(schema.deployment.status, ["queued", "building", "deploying"]));
  const busyIds = new Set(busy.map((b) => b.serviceId));
  const byId = new Map(services.map((s) => [s.id, s]));
  let removed = 0;
  for (const c of containers) {
    const service = byId.get(c.Labels[LABEL.service]);
    const deployment = c.Labels[LABEL.deployment];
    if (!service || service.type !== "app" || !deployment) continue;
    if (service.status === "stopped" || busyIds.has(service.id) || deployment === service.currentDeploymentId) continue;
    await removeContainer(c.Id, 5, ctx.docker).catch(() => {});
    removed++;
  }
  return removed;
}

const active = new Map<string, Promise<CleanupRun>>();

/**
 * Housekeeping for one server's Docker (and, on the local server, Serve's own
 * data). Routine runs only touch Serve's images and containers; manual and
 * low-disk runs also reclaim host-wide caches. One run per server at a time.
 */
export function runCleanup(trigger: Trigger, serverId: string = LOCAL_SERVER_ID): Promise<CleanupRun> {
  let run = active.get(serverId);
  if (!run) {
    run = doCleanup(trigger, serverId).finally(() => active.delete(serverId));
    active.set(serverId, run);
  }
  return run;
}

async function doCleanup(trigger: Trigger, serverId: string): Promise<CleanupRun> {
  const started = Date.now();
  const settings = await getSettings();
  let reclaimed = 0;
  let error: string | null = null;
  let serverName = serverId;
  try {
    const ctx = await getServer(serverId);
    serverName = ctx.name;
    if (ctx.local) {
      await pruneJobs();
      await pruneMetrics();
      await pruneRequestMetrics();
      await db.execute(dsql`DELETE FROM activity WHERE created_at < now() - interval '90 days'`);
    }

    await removeStaleContainers(ctx);
    // Dangling layers from Serve builds.
    reclaimed += await docker_(ctx, ["image", "prune", "-f", "--filter", `label=${LABEL.managed}=true`]);

    const cacheDays = trigger === "disk" ? 1 : settings.cleanupBuildCacheDays;
    if (cacheDays > 0) reclaimed += await docker_(ctx, ["builder", "prune", "-f", "--filter", `until=${cacheDays * 24}h`]);

    if (trigger !== "schedule") reclaimed += await docker_(ctx, ["image", "prune", "-f"]);

    // Unused images, except Serve's own tags: the deploy pipeline keeps those for rollbacks.
    if (settings.cleanupUnusedImages || trigger === "disk") {
      reclaimed += await docker_(ctx, ["image", "prune", "-af", "--filter", "until=24h", "--filter", `label!=${LABEL.managed}`]);
    }
  } catch (e) {
    error = (e as Error).message;
  }

  const result: CleanupRun = { at: new Date().toISOString(), trigger, reclaimed, durationMs: Date.now() - started, error, serverId, serverName };
  const latest = await getSettings();
  await updateSettings({ lastCleanup: result, cleanupHistory: [result, ...latest.cleanupHistory].slice(0, 30) });
  return result;
}

/** Runs of one server, newest first. Runs recorded before multi-server belong to the local server. */
export function cleanupRunsFor(history: CleanupRun[], serverId: string) {
  return history.filter((r) => (r.serverId ?? LOCAL_SERVER_ID) === serverId);
}

const HOUR = 3600_000;

/** Called every few minutes by the worker: interval and low-disk runs on every reachable server. */
export async function scheduleCleanup() {
  const servers = await db.select({ id: schema.server.id, isLocal: schema.server.isLocal, status: schema.server.status }).from(schema.server);
  const results = await Promise.allSettled(servers.filter((s) => s.isLocal || s.status === "ready").map((s) => scheduleOn(s.id)));
  const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  if (failed) throw failed.reason;
}

async function scheduleOn(serverId: string) {
  const settings = await getSettings();
  const history = cleanupRunsFor(settings.cleanupHistory, serverId);
  const ctx = await getServer(serverId);

  const snap = await serverSnapshot(ctx).catch(() => null);
  const percent = snap?.disk.total ? (snap.disk.used / snap.disk.total) * 100 : 0;
  if (percent >= settings.cleanupDiskThreshold) {
    const lastDisk = history.find((r) => r.trigger === "disk");
    if (!lastDisk || Date.now() - new Date(lastDisk.at).getTime() > HOUR) {
      const result = await runCleanup("disk", serverId);
      const after = await serverSnapshot(ctx).catch(() => null);
      const nowPercent = after?.disk.total ? Math.round((after.disk.used / after.disk.total) * 100) : Math.round(percent);
      const where = ctx.local ? "" : ` on ${ctx.name}`;
      await notify(settings.rootOrganizationId, "server.disk", {
        ok: false,
        title: `Disk is ${Math.round(percent)}% full${where}`,
        body: `Serve ran an automatic cleanup and freed ${formatSize(result.reclaimed)}. The disk is now ${nowPercent}% full.`,
        url: `/servers/${serverId}/cleanup`,
      }).catch(() => {});
      return;
    }
  }

  if (!settings.cleanupEnabled) return;
  const lastScheduled = history.find((r) => r.trigger === "schedule");
  if (lastScheduled && Date.now() - new Date(lastScheduled.at).getTime() < settings.cleanupIntervalHours * HOUR) return;
  await runCleanup("schedule", serverId);
}

function formatSize(bytes: number) {
  if (bytes < 1e6) return `${Math.round(bytes / 1e3)} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}
