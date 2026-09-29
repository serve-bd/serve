import { inArray, sql as dsql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { docker, LABEL, removeContainer } from "@/server/docker/client";
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

async function docker_(args: string[]) {
  try {
    return parseReclaimed(await run("docker", args));
  } catch {
    return 0;
  }
}

/**
 * Stopped Serve containers left behind by older deployments (for example a
 * failed zero-downtime switch). Only touches services this instance knows,
 * never the current deployment, stopped services or services mid-deploy.
 */
async function removeStaleContainers() {
  const containers = await docker.listContainers({ all: true, filters: { label: [`${LABEL.managed}=true`], status: ["exited", "created", "dead"] } });
  const ids = [...new Set(containers.map((c) => c.Labels[LABEL.service]).filter(Boolean))];
  if (!ids.length) return 0;
  const services = await db.select().from(schema.service).where(inArray(schema.service.id, ids));
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
    await removeContainer(c.Id, 5).catch(() => {});
    removed++;
  }
  return removed;
}

let active: Promise<CleanupRun> | null = null;

/**
 * Housekeeping for Serve's data and Docker. Routine runs only touch Serve's own
 * images and containers; manual and low-disk runs also reclaim host-wide caches.
 */
export function runCleanup(trigger: Trigger): Promise<CleanupRun> {
  active ??= doCleanup(trigger).finally(() => {
    active = null;
  });
  return active;
}

async function doCleanup(trigger: Trigger): Promise<CleanupRun> {
  const started = Date.now();
  const settings = await getSettings();
  let reclaimed = 0;
  let error: string | null = null;
  try {
    await pruneJobs();
    await pruneMetrics();
    await pruneRequestMetrics();
    await db.execute(dsql`DELETE FROM activity WHERE created_at < now() - interval '90 days'`);

    await removeStaleContainers();
    // Dangling layers from Serve builds.
    reclaimed += await docker_(["image", "prune", "-f", "--filter", `label=${LABEL.managed}=true`]);

    const cacheDays = trigger === "disk" ? 1 : settings.cleanupBuildCacheDays;
    if (cacheDays > 0) reclaimed += await docker_(["builder", "prune", "-f", "--filter", `until=${cacheDays * 24}h`]);

    if (trigger !== "schedule") reclaimed += await docker_(["image", "prune", "-f"]);

    // Unused images, except Serve's own tags: the deploy pipeline keeps those for rollbacks.
    if (settings.cleanupUnusedImages || trigger === "disk") {
      reclaimed += await docker_(["image", "prune", "-af", "--filter", "until=24h", "--filter", `label!=${LABEL.managed}`]);
    }
  } catch (e) {
    error = (e as Error).message;
  }

  const result: CleanupRun = { at: new Date().toISOString(), trigger, reclaimed, durationMs: Date.now() - started, error };
  const latest = await getSettings();
  await updateSettings({ lastCleanup: result, cleanupHistory: [result, ...latest.cleanupHistory].slice(0, 10) });
  return result;
}

const HOUR = 3600_000;

/** Called every few minutes by the worker: interval runs and low-disk runs. */
export async function scheduleCleanup() {
  const settings = await getSettings();
  const history = settings.cleanupHistory;

  const snap = await serverSnapshot().catch(() => null);
  const percent = snap?.disk.total ? (snap.disk.used / snap.disk.total) * 100 : 0;
  if (percent >= settings.cleanupDiskThreshold) {
    const lastDisk = history.find((r) => r.trigger === "disk");
    if (!lastDisk || Date.now() - new Date(lastDisk.at).getTime() > HOUR) {
      const result = await runCleanup("disk");
      const after = await serverSnapshot().catch(() => null);
      const nowPercent = after?.disk.total ? Math.round((after.disk.used / after.disk.total) * 100) : Math.round(percent);
      await notify(settings.rootOrganizationId, "server.disk", {
        ok: false,
        title: `Disk is ${Math.round(percent)}% full`,
        body: `Serve ran an automatic cleanup and freed ${formatSize(result.reclaimed)}. The disk is now ${nowPercent}% full.`,
        url: "/server/cleanup",
      }).catch(() => {});
      return;
    }
  }

  if (!settings.cleanupEnabled) return;
  const lastScheduled = history.find((r) => r.trigger === "schedule");
  if (lastScheduled && Date.now() - new Date(lastScheduled.at).getTime() < settings.cleanupIntervalHours * HOUR) return;
  await runCleanup("schedule");
}

function formatSize(bytes: number) {
  if (bytes < 1e6) return `${Math.round(bytes / 1e3)} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}
