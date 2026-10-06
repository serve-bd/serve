// Must stay first: every other import may read the environment when it loads.
import { decrypt } from "@/server/crypto";
import "dotenv/config";

// A rejected promise nobody awaits must not take the worker down.
process.on("unhandledRejection", (reason) => console.error("[worker] unhandled rejection:", reason instanceof Error ? reason.message : reason));
import fs from "node:fs";
import path from "node:path";
import { paths } from "@/server/paths";
import { checkLimitNotices, hasRoomFor, measureOrgDisk } from "@/server/limits";
import { CHECK_INTERVAL_MS, checkBalances } from "@/server/services/balance-health";
import { copyEnvironmentData, failInterruptedCopy, preparePreviewDatabase } from "@/server/services/environments";
import { and, sql as dsql, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import type { ProxyKind } from "@/server/proxy/config";
import { CronExpressionParser } from "cron-parser";
import { db, schema, sql } from "@/server/db";
import { runMigrations } from "@/server/db/migrate";
import { fullBuildServers } from "@/lib/server-limits";
import { JobTimeout, jobTimeoutMinutes } from "@/lib/job-timeouts";
import type { ServiceStatus } from "@/server/db/schema";
import { newId } from "@/server/id";
import { docker, ensureNetwork, LABEL, listServiceContainers } from "@/server/docker/client";
import { ensureProxy, ensureServerProxy, syncAllProxy, syncCloudflareTrusting, syncHostRelays, syncLocalProxy, syncRemoteProxies } from "@/server/proxy/nginx";
import { anyServerTrustsCloudflare, refreshCloudflareRanges } from "@/server/proxy/trusted-proxies";
import { buildServerForDeployment, CANCEL_CHANNEL, claimJob, enqueue, failJob, finishJob, JOB_CHANNEL, recoverStaleJobs, type Job, type JobPayloads } from "@/server/queue";
import { recoverInterruptedDeployment, runDeployment, setServiceStatus } from "@/server/deploy";
import { destroyService, extraCleanupKey, restartService, startService, stopService } from "@/server/services/lifecycle";
import { queueDeployment } from "@/server/services/create";
import { issueCertificate, renewDueCertificates, retireCertificate, retryFailedCertificates } from "@/server/ssl/certificates";
import { backupFile, importBackup, restoreBackup, runBackup } from "@/server/backups";
import { collectMetrics } from "@/server/metrics";
import { containerLister, type ContainerView, withTimeout } from "@/server/monitoring/containers";

type ContainerList = Awaited<ReturnType<typeof containerLister>>;
import { syncMetricsAgents } from "@/server/metrics-agent";
import { rollupRecent } from "@/server/metric-rollups";
import { getSettings, updateSettings } from "@/server/settings";
import { notify, orgOfService } from "@/server/notify";
import { runTask, scheduleTasks } from "@/server/services/tasks";
import { ingestAccessLog } from "@/server/analytics";
import { pruneRequestLog } from "@/server/request-log";
import { runCleanup, scheduleCleanup } from "@/server/cleanup";
import { probeServer, setupServer } from "@/server/servers/setup";
import { getServer, serverOf } from "@/server/servers/context";
import { SCHEMA_VERSION } from "@/server/version";
import { checkTunnels } from "@/server/cloudflare/tunnels";
import { shutdownTunnels, syncTunnels } from "@/server/tunnel/listener";
import { checkContainerHealth, checkServerResources, pruneMonitoring, runUptimeChecks } from "@/server/monitoring/checks";
import { enforceCrashLimits } from "@/server/monitoring/crash-limit";
import { failInstanceBackup, failInterruptedInstanceBackups, runInstanceBackup, scheduleInstanceBackups } from "@/server/instance/backups";
import { runBranchJob } from "@/server/databases/branches";
import { periodicUpdateCheck, reconcileUpdate, runUpdate } from "@/server/instance/updates";
import { syncMesh } from "@/server/mesh";
import { startStoppedContainers } from "@/server/backups/storage";
import { currentVersion } from "@/server/instance/version";
import { attemptDelivery, flushHeldNotifications, pruneDeliveries, retryDueDeliveries } from "@/server/notifications/deliver";
import { recordSchedulerRun, recordSchedulerSkip } from "@/server/schedulers";
import { ensureServerCli } from "@/server/server-cli";
import { pruneCliLogins } from "@/server/cli-login";
import { withJobSignal } from "@/server/job-signal";

const log = (...args: unknown[]) => console.log(`[worker ${new Date().toISOString()}]`, ...args);

/** Running jobs; a deploy also records the server that builds it, for per-server build slots. */
const running = new Map<string, { job: Job; controller: AbortController; buildServer?: string | null }>();
let wake: (() => void) | null = null;
let stopping = false;
/** A server did not take Cloudflare's latest ranges yet. */
let cloudflareSyncPending = false;

async function handle(job: Job, signal: AbortSignal) {
  const p = job.payload as Record<string, string>;
  switch (job.type) {
    case "deploy":
      return runDeployment(p.deploymentId, signal);
    case "service.stop":
      return stopService(p.serviceId);
    case "service.start":
      // Its containers were removed outside Serve: the start becomes a deployment, not a stuck "deploying".
      if ((await startService(p.serviceId)) === "needs-deploy") await queueDeployment(p.serviceId, "manual");
      return;
    case "service.restart":
      return restartService(p.serviceId);
    case "service.delete":
      return destroyService(job.payload as never);
    case "environment.copy-data":
      return copyEnvironmentData(job.payload as JobPayloads["environment.copy-data"]);
    case "preview.database":
      return preparePreviewDatabase(job.payload as JobPayloads["preview.database"]);
    case "database.branch":
      return runBranchJob(job.payload as JobPayloads["database.branch"]);
    case "certificate.issue":
      return issueCertificate(p.certificateId);
    case "certificate.retire":
      return retireCertificate(p.certificateId);
    case "certificate.renew-all":
      return renewDueCertificates();
    case "backup.run":
      return runBackup(p.backupId, undefined, (job.payload as JobPayloads["backup.run"]).choice);
    case "backup.verify": {
      const { verifyBackup } = await import("@/server/backups/verify");
      return void (await verifyBackup(p.backupId));
    }
    case "backup.restore":
      return void (await restoreBackup(
        p.backupId,
        (({ backupId: _, passphrase, ...opts }) => ({ ...opts, passphrase: passphrase ? decrypt(passphrase) : undefined }))(job.payload as JobPayloads["backup.restore"]),
      ));
    case "backup.import": {
      const { backupId, passphrase, ...opts } = job.payload as JobPayloads["backup.import"];
      return importBackup(backupId, { ...opts, passphrase: passphrase ? decrypt(passphrase) : undefined });
    }
    case "proxy.sync":
      await ensureProxy();
      return syncAllProxy();
    case "cleanup": {
      const payload = job.payload as { full?: boolean; serverId?: string };
      return void (await runCleanup(payload.full === true ? "manual" : "schedule", payload.serverId));
    }
    case "task.run":
      return runTask(p.runId);
    case "server.setup":
      return setupServer(p.serverId, { installDocker: (job.payload as { installDocker?: boolean }).installDocker === true });
    case "server.os-updates": {
      const os = await import("@/server/servers/os-updates");
      const q = job.payload as { serverId: string; op: "check" | "install"; what?: "all" | string[]; notify?: boolean };
      if (q.op === "install") return os.installOsUpdates(q.serverId, q.what ?? "all");
      await os.checkOsUpdates(q.serverId);
      if (q.notify) await os.notifyOsUpdates(q.serverId);
      return;
    }
    case "instance.backup":
      return runInstanceBackup(p.backupId, (l) => log(`instance backup: ${l}`));
    case "instance.update":
      return runUpdate(p.to);
    case "notification.deliver":
      return void (await attemptDelivery(p.deliveryId));
    case "status.notify": {
      const { notifyNotice } = await import("@/server/status-pages/subscribers");
      const q = job.payload as JobPayloads["status.notify"];
      return notifyNotice(q.noticeId, q.event, { notify: q.notify, kinds: q.kinds, channels: q.channels });
    }
    case "status.outage": {
      const { notifyOutage } = await import("@/server/status-pages/subscribers");
      const q = job.payload as JobPayloads["status.outage"];
      const [incident] = await db.select().from(schema.incident).where(eq(schema.incident.id, q.incidentId));
      if (incident) await notifyOutage(q.serviceId, incident);
      return;
    }
    case "commit.status": {
      const { reportCommitStatus } = await import("@/server/git/commit-status");
      const q = job.payload as JobPayloads["commit.status"];
      return void (await reportCommitStatus(q.deploymentId, q.status, { last: job.attempts >= job.maxAttempts }));
    }
    case "mesh.sync":
      return syncMesh();
    case "tunnel.sync":
      return syncTunnels();
    case "proxy.switch": {
      const { switchProxy } = await import("@/server/proxy/switch");
      return switchProxy(p.serverId, p.to as ProxyKind);
    }
  }
}

/** The limits a job set for itself (a service's build timeout, a task's timeout) raise its own. */
async function timeoutOf(job: Job) {
  const p = job.payload as Record<string, string>;
  if (job.type === "deploy") {
    const [row] = await db
      .select({ build: schema.service.build, serverLimit: schema.server.deployTimeoutMinutes })
      .from(schema.deployment)
      .innerJoin(schema.service, eq(schema.service.id, schema.deployment.serviceId))
      .leftJoin(schema.server, eq(schema.server.id, schema.service.serverId))
      .where(eq(schema.deployment.id, p.deploymentId));
    return jobTimeoutMinutes(job.type, { buildTimeoutMinutes: row?.build?.buildTimeoutMinutes, serverDeployMinutes: row?.serverLimit });
  }
  if (job.type === "task.run") {
    const [row] = await db
      .select({ timeoutSeconds: schema.scheduledTask.timeoutSeconds })
      .from(schema.taskRun)
      .innerJoin(schema.scheduledTask, eq(schema.scheduledTask.id, schema.taskRun.taskId))
      .where(eq(schema.taskRun.id, p.runId));
    return jobTimeoutMinutes(job.type, { taskTimeoutSeconds: row?.timeoutSeconds });
  }
  if (job.type === "backup.run") {
    const [row] = await db
      .select({ target: schema.backup.target, database: schema.service.database, composeBackups: schema.service.composeBackups })
      .from(schema.backup)
      .innerJoin(schema.service, eq(schema.service.id, schema.backup.serviceId))
      .where(eq(schema.backup.id, p.backupId));
    const minutes = row?.target ? row.composeBackups?.[row.target]?.timeoutMinutes : row?.database?.backupTimeoutMinutes;
    return jobTimeoutMinutes(job.type, { backupTimeoutMinutes: minutes });
  }
  return jobTimeoutMinutes(job.type);
}

/** After the abort, a deploy still puts the previous version back and records the outcome. */
const TIMEOUT_GRACE_MS = 60_000;
const STOP_BEFORE_FREEING = new Set<string>(["backup.run", "backup.restore", "backup.import"]);

async function execute(job: Job, buildServer: string | null = null) {
  const controller = new AbortController();
  running.set(job.id, { job, controller, buildServer });
  const started = Date.now();
  const minutes = await timeoutOf(job).catch(() => jobTimeoutMinutes(job.type));
  const work = withJobSignal(controller.signal, () => handle(job, controller.signal));
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), minutes * 60_000);
  });
  try {
    if ((await Promise.race([work, expired])) === "expired") return await giveUp(job, controller, work, minutes);
    await finishJob(job.id, null);
    log(`${job.type} ${job.id} done in ${Date.now() - started}ms`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishJob(job.id, message.slice(0, 4000));
    log(`${job.type} ${job.id} failed: ${message.split("\n")[0]}`);
  } finally {
    clearTimeout(timer);
    running.delete(job.id);
    wake?.();
  }
}

/**
 * A job past its time limit: aborted (handlers that take a signal stop there), given a moment to
 * wind down, then failed whether or not it returned, which frees its concurrency key for the jobs
 * waiting behind it. What it left half done is settled like after a restart. A handler that hangs
 * on regardless keeps running in the background, but nothing waits for it any more (backup jobs
 * excepted: their commands are killed, and the job ends when they have stopped).
 */
async function giveUp(job: Job, controller: AbortController, work: Promise<unknown>, minutes: number) {
  const reason = job.type === "deploy" ? new JobTimeout(minutes, "the deployment ran past its time limit (its server's, or Serve's default)") : new JobTimeout(minutes);
  log(`${job.type} ${job.id} ran past its ${minutes} minute limit; stopping it`);
  controller.abort(reason);
  // A backup, restore or import left running would meet the next one on the same database: the abort
  // killed its commands, and its concurrency key stays held until it has really returned.
  if (STOP_BEFORE_FREEING.has(job.type)) await work.catch(() => {});
  else {
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([work.catch(() => {}), new Promise<void>((resolve) => (grace = setTimeout(resolve, TIMEOUT_GRACE_MS)))]);
    clearTimeout(grace);
  }
  await failJob(job.id, reason.message);
  await settleTimedOut(job, reason.message).catch((e: Error) => log(`settling ${job.type} ${job.id} failed: ${e.message}`));
}

/** Service status from its containers, for a start or stop that never finished. */
async function settleFromContainers(serviceId: string, pending: ServiceStatus) {
  const [service] = await db.select().from(schema.service).where(eq(schema.service.id, serviceId));
  if (service?.status !== pending) return;
  const server = await getServer(service.serverId).catch(() => null);
  const up = server ? await listServiceContainers(service.id, false, server.docker).catch(() => null) : null;
  if (up) await setServiceStatus(service.id, up.length ? "running" : pending === "stopped" ? "stopped" : "crashed");
}

async function failProxySwitch(serverId: string, line: string) {
  const [row] = await db.select({ sw: schema.server.proxySwitch }).from(schema.server).where(eq(schema.server.id, serverId));
  if (row?.sw?.state !== "running") return;
  await db
    .update(schema.server)
    .set({ proxySwitch: { ...row.sw, state: "failed", finishedAt: new Date().toISOString(), log: `${row.sw.log}${line}\n` } })
    .where(eq(schema.server.id, serverId));
}

async function failBranch(payload: JobPayloads["database.branch"], error: string) {
  await db
    .update(schema.databaseBranch)
    .set({ status: "failed", error, updatedAt: new Date() })
    .where(and(eq(schema.databaseBranch.id, payload.branchId), inArray(schema.databaseBranch.status, ["creating", "resetting", "deleting"])));
}

/** Put what a job past its time limit left half done in a final state, like recover() after a restart. */
async function settleTimedOut(job: Job, error: string) {
  const p = job.payload as Record<string, string>;
  switch (job.type) {
    case "deploy": {
      const [dep] = await db
        .update(schema.deployment)
        .set({ status: "failed", error, finishedAt: new Date() })
        .where(and(eq(schema.deployment.id, p.deploymentId), inArray(schema.deployment.status, ["building", "deploying"])))
        .returning({ id: schema.deployment.id, serviceId: schema.deployment.serviceId, startedAt: schema.deployment.startedAt });
      if (!dep) return;
      const { queueCommitStatus } = await import("@/server/git/commit-status");
      await queueCommitStatus(dep.id);
      const [service] = await db.select({ serverId: schema.service.serverId }).from(schema.service).where(eq(schema.service.id, dep.serviceId));
      const server = service ? await getServer(service.serverId).catch(() => null) : null;
      const up = server ? await recoverInterruptedDeployment(dep, server.docker).catch(() => false) : false;
      return setServiceStatus(dep.serviceId, up ? "running" : "failed");
    }
    case "service.start":
      return settleFromContainers(p.serviceId, "deploying");
    case "service.stop":
      // Containers that kept running must be watched again: the monitor skips stopped services.
      return settleFromContainers(p.serviceId, "stopped");
    case "task.run":
      await db
        .update(schema.taskRun)
        .set({ status: "failed", finishedAt: new Date(), output: dsql`${schema.taskRun.output} || ${`\n${error}`}` })
        .where(and(eq(schema.taskRun.id, p.runId), eq(schema.taskRun.status, "running")));
      return;
    case "proxy.switch":
      return failProxySwitch(p.serverId, `${error} Switch again to finish it.`);
    case "server.os-updates": {
      const { failOsUpdateRun } = await import("@/server/servers/os-updates");
      return failOsUpdateRun(p.serverId, error);
    }
    case "database.branch":
      return failBranch(job.payload as JobPayloads["database.branch"], error);
    case "preview.database":
      return void (await preparePreviewDatabase(job.payload as JobPayloads["preview.database"], { interrupted: true }));
    case "environment.copy-data":
      return failInterruptedCopy(job.payload as JobPayloads["environment.copy-data"], "it ran past its time limit.");
    case "server.setup":
      // As a failed setup leaves it: the health probe tries it again.
      await db
        .update(schema.server)
        .set({ status: "unreachable", statusMessage: error })
        .where(and(eq(schema.server.id, p.serverId), eq(schema.server.status, "validating")));
      return;
    case "certificate.issue":
      await db
        .update(schema.certificate)
        .set({ status: "failed", lastError: error })
        .where(and(eq(schema.certificate.id, p.certificateId), eq(schema.certificate.status, "issuing")));
      return;
    case "backup.run":
    case "backup.restore":
    case "backup.import": {
      const [b] = await db.select().from(schema.backup).where(eq(schema.backup.id, p.backupId));
      if (!b) return;
      if (b.status === "running") {
        await db
          .update(schema.backup)
          .set({ status: "failed", error, finishedAt: new Date() })
          .where(and(eq(schema.backup.id, b.id), eq(schema.backup.status, "running")));
        // A partial file; an uploaded import is complete and stays.
        if (b.filename && !(b.trigger === "import" && b.size != null)) {
          await fs.promises.rm(backupFile(b.serviceId, b.filename), { force: true }).catch(() => {});
          // Cut off while it was encrypted: the plain dump next to it goes too.
          if (b.filename.endsWith(".enc")) await fs.promises.rm(backupFile(b.serviceId, b.filename.slice(0, -4)), { force: true }).catch(() => {});
          await db.update(schema.backup).set({ filename: null }).where(eq(schema.backup.id, b.id));
        }
      }
      if (b.restoreStatus === "running") {
        await db
          .update(schema.backup)
          .set({ restoreStatus: "failed", restoredAt: new Date() })
          .where(and(eq(schema.backup.id, b.id), eq(schema.backup.restoreStatus, "running")));
        // Containers a storage restore stopped come back.
        if (b.restoreStopped?.length) {
          const [service] = await db.select().from(schema.service).where(eq(schema.service.id, b.serviceId));
          const server = service ? await getServer(service.serverId).catch(() => null) : null;
          if (server) await startStoppedContainers(server.docker, b.restoreStopped).catch(() => {});
          await db.update(schema.backup).set({ restoreStopped: null }).where(eq(schema.backup.id, b.id));
        }
      }
      return;
    }
    case "instance.backup":
      return failInstanceBackup(p.backupId, error);
    case "instance.update": {
      const run = (await getSettings()).updateRun;
      if (run?.state === "backing-up" && run.to === p.to)
        await updateSettings({ updateRun: { ...run, state: "failed", finishedAt: new Date().toISOString(), log: `${run.log}==> ${error} Nothing was changed.\n` } });
      return;
    }
  }
}

async function loop() {
  while (!stopping) {
    // Build slots are per server: only a full server holds back its own builds.
    const limits = new Map(
      (
        await db
          .select({ id: schema.server.id, buildConcurrency: schema.server.buildConcurrency })
          .from(schema.server)
          .catch(() => [] as { id: string; buildConcurrency: number }[])
      ).map((s) => [s.id, s.buildConcurrency]),
    );
    const runningDeploys = [...running.values()].filter((r) => r.job.type === "deploy");
    const fullServers = fullBuildServers(
      runningDeploys.map((r) => r.buildServer ?? null),
      limits,
    );
    const others = running.size - runningDeploys.length;
    let claimed = false;

    const othersFull = others >= 4;
    {
      const busyKeys = [...running.values()].map((r) => r.job.concurrencyKey).filter(Boolean) as string[];
      try {
        // Only ask for job types that have a free slot, so a waiting build never blocks other work.
        // Deploys on full build servers wait in claimJob, unless they build nothing or were force started.
        const job = await claimJob(busyKeys, othersFull ? { onlyTypes: ["deploy"], fullBuildServers: fullServers } : { fullBuildServers: fullServers });
        if (job) {
          claimed = true;
          const buildServer = job.type === "deploy" ? await buildServerForDeployment((job.payload as { deploymentId: string }).deploymentId).catch(() => null) : null;
          execute(job, buildServer).catch((error: Error) => log(`job ${job.id} could not be finished:`, error.message));
        }
      } catch (error) {
        log("claim failed", (error as Error).message);
      }
    }
    if (!claimed) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 2000);
        wake = () => {
          clearTimeout(t);
          wake = null;
          resolve();
        };
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                 Schedulers                                 */
/* -------------------------------------------------------------------------- */

function every(ms: number, name: string, fn: () => Promise<unknown>, runNow = false) {
  let busy = false;
  const tick = async () => {
    if (stopping) return;
    if (busy) {
      void recordSchedulerSkip(name, ms);
      return;
    }
    busy = true;
    let timer: NodeJS.Timeout | undefined;
    const startedAt = new Date();
    let failure: string | null = null;
    try {
      // A tick stuck on a server that never answers must not stop every later tick.
      await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("still running after an hour; letting the next tick run")), 3_600_000).unref();
        }),
      ]);
    } catch (error) {
      failure = (error as Error).message.slice(0, 2000);
      log(`${name} failed:`, failure);
    } finally {
      // Ticks every few seconds would otherwise pile up an hour's worth of pending timers.
      clearTimeout(timer);
      busy = false;
      void recordSchedulerRun(name, ms, startedAt, failure);
    }
  };
  if (runNow) void tick();
  return setInterval(tick, ms);
}

const lastProbe = new Map<string, number>();

/**
 * Keeps remote server status fresh (ready / unreachable). A server whose agent keeps reporting is
 * clearly up, so SSH is checked every 5 minutes there instead of every minute.
 */
async function probeRemoteServers() {
  const rows = await db.select({ id: schema.server.id, status: schema.server.status, agent: schema.server.agent }).from(schema.server).where(eq(schema.server.isLocal, false));
  const now = Date.now();
  await Promise.all(
    rows
      .filter((r) => r.status === "ready" || r.status === "unreachable")
      .filter((r) => {
        const reporting = r.status === "ready" && !!r.agent?.seenAt && now - new Date(r.agent.seenAt).getTime() < 90_000;
        return !reporting || now - (lastProbe.get(r.id) ?? 0) >= 5 * 60_000;
      })
      .map((r) => {
        lastProbe.set(r.id, now);
        return probeServer(r.id);
      }),
  );
}

/** Servers whose Docker can be asked right now: the local one and ready remote ones. */
async function reachableServers() {
  const rows = await db.select({ id: schema.server.id, isLocal: schema.server.isLocal, status: schema.server.status }).from(schema.server);
  return new Set(rows.filter((r) => r.isLocal || r.status === "ready").map((r) => r.id));
}

/**
 * Detect crashed or recovered services by looking at their containers: one list per server (its
 * agent's report, or one Docker call), servers side by side, so a slow one holds up only itself.
 */
async function monitorServices(list: ContainerList) {
  const services = await db
    .select()
    .from(schema.service)
    .where(inArray(schema.service.status, ["running", "crashed", "restarting"]));
  const reachable = await reachableServers();
  const byServer = new Map<string, (typeof services)[number][]>();
  // An unreachable server says nothing about its services; keep their last known status.
  for (const s of services) if (reachable.has(s.serverId)) byServer.set(s.serverId, [...(byServer.get(s.serverId) ?? []), s]);
  await Promise.all(
    [...byServer].map(async ([serverId, onServer]) => {
      const all = await list(serverId).catch(() => null);
      if (!all) return;
      for (const s of onServer)
        await checkServiceContainers(
          s,
          all.filter((c) => c.Labels[LABEL.service] === s.id),
        );
    }),
  );
}

/** Running, restarting or crashed, from a service's containers; null when it has none. */
function containerStatus(s: typeof schema.service.$inferSelect, containers: ContainerView[]): "running" | "restarting" | "crashed" | null {
  const relevant = s.type === "app" ? containers.filter((c) => c.Labels[LABEL.deployment] === s.currentDeploymentId) : containers;
  if (!relevant.length) return null;
  const up = relevant.filter((c) => c.State === "running");
  const restarting = relevant.some((c) => c.State === "restarting");
  return up.length === relevant.length ? "running" : restarting ? "restarting" : up.length ? "running" : "crashed";
}

async function checkServiceContainers(s: typeof schema.service.$inferSelect, reported: ContainerView[]) {
  let next = containerStatus(s, reported);
  if (next === s.status) return;
  // Bad news from an agent report (it can be seconds behind a deploy) is checked live before acting.
  if (next !== "running" && reported.some((c) => c.info)) {
    const live = await withTimeout(serverOf(s).then((server) => listServiceContainers(s.id, true, server.docker))).catch(() => null);
    if (!live) return;
    next = containerStatus(s, live as ContainerView[]);
    if (next === s.status) return;
  }
  // Only if nothing changed since the services were read: a deploy that started meanwhile
  // ("building") or switched to new containers (the old ones are gone) must not be marked crashed.
  const settle = async (status: "running" | "restarting" | "crashed") =>
    (
      await db
        .update(schema.service)
        .set({ status })
        .where(
          and(
            eq(schema.service.id, s.id),
            eq(schema.service.status, s.status),
            s.currentDeploymentId ? eq(schema.service.currentDeploymentId, s.currentDeploymentId) : isNull(schema.service.currentDeploymentId),
          ),
        )
        .returning({ id: schema.service.id })
    ).length > 0;
  // Every container is gone (removed by hand or by a Docker reset).
  if (next === null) {
    if (s.status === "crashed") return;
    if (!(await settle("crashed"))) return;
    void notify(await orgOfService(s.id), "service.crashed", {
      ok: false,
      title: `${s.name} has no containers`,
      body: "Its containers were removed outside Serve. Deploy or restart it to recreate them.",
      url: `/projects/${s.projectId}/services/${s.id}`,
      status: "crashed",
      serviceId: s.id,
    });
    return;
  }
  if (!(await settle(next))) return;
  if (next === "crashed") {
    void notify(await orgOfService(s.id), "service.crashed", {
      ok: false,
      title: `${s.name} crashed`,
      body: "All containers for this service have stopped.",
      url: `/projects/${s.projectId}/services/${s.id}`,
      status: "crashed",
      serviceId: s.id,
    });
  }
}

/** Restarts a stopped or missing proxy on every reachable server. */
async function checkProxies() {
  const reachable = await reachableServers();
  for (const id of reachable) {
    try {
      const server = await getServer(id);
      const info = await server.docker
        .getContainer(server.proxyContainer)
        .inspect()
        .catch(() => null);
      if (!info?.State.Running) await ensureServerProxy(server, (l) => log(`[${server.name}] ${l}`));
    } catch (error) {
      log(`proxy check on ${id} failed:`, (error as Error).message);
    }
  }
}

const lastBackupRun = new Map<string, number>();

async function scheduleBackups() {
  const databases = await db
    .select()
    .from(schema.service)
    .where(and(eq(schema.service.type, "database"), isNotNull(schema.service.database)));
  const stacks = await db
    .select()
    .from(schema.service)
    .where(and(inArray(schema.service.type, ["compose", "app"]), isNotNull(schema.service.composeBackups)));
  // One entry per schedule: a database service, or one backup of a compose stack (target key).
  const due = [
    ...databases.map((s) => ({ service: s, target: null as string | null, cron: s.database?.backupSchedule })),
    ...stacks.flatMap((s) => Object.entries(s.composeBackups ?? {}).map(([target, cfg]) => ({ service: s, target, cron: cfg.schedule }))),
  ];
  const now = new Date();
  const tz = (await getSettings()).timezone;
  for (const { service: s, target, cron } of due) {
    if (!cron) continue;
    const runKey = `${s.id}:${target ?? ""}`;
    try {
      const prev = CronExpressionParser.parse(cron, { currentDate: now, tz }).prev().toDate().getTime();
      // Fire if the previous occurrence happened within the last minute and was not handled yet.
      if (now.getTime() - prev < 60_000 && lastBackupRun.get(runKey) !== prev) {
        lastBackupRun.set(runKey, prev);
        // A full backup storage limit skips the scheduled backup (the organization is notified).
        const [owner] = await db
          .select({ organizationId: schema.project.organizationId })
          .from(schema.project)
          .innerJoin(schema.service, eq(schema.service.projectId, schema.project.id))
          .where(eq(schema.service.id, s.id));
        if (owner && !(await hasRoomFor(owner.organizationId, "backupStorage"))) continue;
        const id = newId();
        await db.insert(schema.backup).values({ id, serviceId: s.id, target, trigger: "schedule" });
        await enqueue("backup.run", { backupId: id }, { concurrencyKey: `backup:${s.id}` });
      }
    } catch {
      // invalid cron, ignore
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                    Boot                                    */
/* -------------------------------------------------------------------------- */

async function recover() {
  // A backup cut off by a restart left a partial file and a "running" record.
  await failInterruptedInstanceBackups().catch(() => {});
  // Backup tests the last worker was running when it stopped: tested again on the next round.
  await db
    .update(schema.backup)
    .set({ verifyStatus: null })
    .where(eq(schema.backup.verifyStatus, "running"))
    .catch(() => {});
  const stale = await recoverStaleJobs();
  if (stale.length) log(`Recovered ${stale.length} interrupted job(s)`);
  // Clones of builds and fetches cut off by the restart (none runs now). Their ".auth" folders
  // hold the git SSH key, which is otherwise removed right after the clone.
  for (const entry of await fs.promises.readdir(paths.builds).catch(() => [] as string[])) {
    await fs.promises.rm(path.join(paths.builds, entry), { recursive: true, force: true }).catch(() => {});
  }
  const servicesDir = path.dirname(paths.service("x"));
  for (const id of await fs.promises.readdir(servicesDir).catch(() => [] as string[])) {
    await fs.promises.rm(path.join(servicesDir, id, "repo.auth"), { recursive: true, force: true }).catch(() => {});
  }
  // A removal cut off half way: its service row is gone, so nothing else would ever remove the rest.
  for (const j of stale as unknown as { type: string; payload: JobPayloads["service.delete"] }[]) {
    if (j.type === "service.delete")
      await enqueue("service.delete", j.payload, {
        concurrencyKey: j.payload.extraCleanup && j.payload.serverId ? extraCleanupKey(j.payload.serviceId, j.payload.serverId) : `service:${j.payload.serviceId}`,
      });
  }
  // Task runs cut off by the restart: failed now, so "Run now" is not blocked by a run that never ends.
  const cutRuns = (stale as unknown as { type: string; payload: { runId?: string } }[]).filter((j) => j.type === "task.run" && j.payload?.runId).map((j) => j.payload.runId!);
  if (cutRuns.length) {
    await db
      .update(schema.taskRun)
      .set({ status: "failed", finishedAt: new Date(), output: "Interrupted: the worker restarted during this run." })
      .where(and(inArray(schema.taskRun.id, cutRuns), eq(schema.taskRun.status, "running")));
  }
  // A proxy switch cut off by the restart would show as running, and refuse the next switch, for ten minutes.
  for (const j of stale as unknown as { type: string; payload: JobPayloads["proxy.switch"] }[]) {
    if (j.type !== "proxy.switch" || !j.payload?.serverId) continue;
    await failProxySwitch(j.payload.serverId, "The worker restarted during the switch. Switch again to finish it.");
  }
  // A branch copy or removal cut off by the restart would show "Copying data…" forever and block a reset.
  for (const j of stale as unknown as { type: string; payload: JobPayloads["database.branch"] }[]) {
    if (j.type !== "database.branch" || !j.payload?.branchId) continue;
    await failBranch(
      j.payload,
      j.payload.op === "delete" ? "Not deleted: the worker restarted. Delete it again." : "The worker restarted during the copy. Reset the branch to copy it again.",
    );
  }
  // A data copy of a cloned environment cut off by the restart: its databases may be half filled.
  for (const j of stale as unknown as { type: string; payload: JobPayloads["environment.copy-data"] }[]) {
    if (j.type !== "environment.copy-data" || !j.payload?.environmentId) continue;
    await failInterruptedCopy(j.payload, "the worker restarted.").catch((e: Error) => log(`data copy recovery failed: ${e.message}`));
  }
  // A stop cut off by the restart left "stopped", which the monitor does not look at, while some
  // containers may still run: it runs again. Unless something else was asked for the service since.
  for (const j of stale as unknown as { type: string; payload: { serviceId?: string } }[]) {
    if (j.type !== "service.stop" || !j.payload?.serviceId) continue;
    const [service] = await db.select({ status: schema.service.status }).from(schema.service).where(eq(schema.service.id, j.payload.serviceId));
    if (service?.status !== "stopped") continue;
    const [later] = await db
      .select({ id: schema.job.id })
      .from(schema.job)
      .where(and(eq(schema.job.concurrencyKey, `service:${j.payload.serviceId}`), eq(schema.job.status, "pending")))
      .limit(1);
    if (!later) await enqueue("service.stop", { serviceId: j.payload.serviceId }, { concurrencyKey: `service:${j.payload.serviceId}` });
  }
  // A preview's database copy cut off by the restart: the preview would never deploy, and a copy
  // that was restored but not cleaned up would keep the personal data its clean-up SQL removes.
  for (const j of stale as unknown as { type: string; payload: JobPayloads["preview.database"] }[]) {
    if (j.type !== "preview.database" || !j.payload?.previewId) continue;
    await preparePreviewDatabase(j.payload, { interrupted: true }).catch((e: Error) => log(`preview database recovery failed: ${e.message}`));
  }
  // A server setup cut off by the restart (Install Docker takes minutes) would stay "validating",
  // which deploys wait for and the health probe skips: it runs again.
  for (const j of stale as unknown as { type: string; payload: JobPayloads["server.setup"] }[]) {
    if (j.type === "server.setup" && j.payload?.serverId) await enqueue("server.setup", j.payload, { concurrencyKey: `server:${j.payload.serverId}` });
  }
  // An install cut off by the restart would show as running, and refuse every later install.
  for (const j of stale as unknown as { type: string; payload: JobPayloads["server.os-updates"] }[]) {
    if (j.type !== "server.os-updates" || !j.payload?.serverId) continue;
    const { failOsUpdateRun } = await import("@/server/servers/os-updates");
    await failOsUpdateRun(j.payload.serverId, "The worker restarted during the install. Check the server, then install again.").catch(() => {});
  }
  // A start cut off by the restart left "deploying", which the monitor does not look at: the containers say what runs.
  for (const j of stale as unknown as { type: string; payload: { serviceId?: string } }[]) {
    if (j.type === "service.start" && j.payload?.serviceId) await settleFromContainers(j.payload.serviceId, "deploying");
  }
  const stuck = await db
    .update(schema.deployment)
    .set({ status: "failed", error: "The worker restarted during this deployment.", finishedAt: new Date() })
    .where(inArray(schema.deployment.status, ["building", "deploying"]))
    .returning({ id: schema.deployment.id, serviceId: schema.deployment.serviceId, startedAt: schema.deployment.startedAt });
  const { queueCommitStatus } = await import("@/server/git/commit-status");
  for (const dep of stuck) {
    await queueCommitStatus(dep.id);
    const [service] = await db.select({ serverId: schema.service.serverId }).from(schema.service).where(eq(schema.service.id, dep.serviceId));
    const server = service ? await getServer(service.serverId).catch(() => null) : null;
    const up = server ? await recoverInterruptedDeployment(dep, server.docker).catch(() => false) : false;
    await setServiceStatus(dep.serviceId, up ? "running" : "failed");
  }
  // An update cut off while backing up or pulling (the job above is failed now) must not block the next one.
  const run = (await getSettings()).updateRun;
  if (run?.state === "backing-up")
    await updateSettings({
      updateRun: { ...run, state: "failed", finishedAt: new Date().toISOString(), log: `${run.log}==> The worker restarted before the update started. Nothing was changed.\n` },
    });

  // Backups and restores still waiting for their job are left alone: the job runs them later.
  const waiting = await db
    .select({ payload: schema.job.payload })
    .from(schema.job)
    .where(and(eq(schema.job.status, "pending"), inArray(schema.job.type, ["backup.run", "backup.restore", "backup.import"])));
  const waitingIds = [...new Set(waiting.map((j) => (j.payload as { backupId: string }).backupId))];
  const notWaiting = waitingIds.length ? notInArray(schema.backup.id, waitingIds) : undefined;
  // Backups cut off by a restart: failed, and their partial file removed.
  const cut = await db
    .update(schema.backup)
    .set({ status: "failed", error: "The worker restarted during this backup.", finishedAt: new Date() })
    .where(and(eq(schema.backup.status, "running"), notWaiting))
    .returning({ serviceId: schema.backup.serviceId, filename: schema.backup.filename, trigger: schema.backup.trigger, size: schema.backup.size });
  for (const b of cut) {
    // An uploaded import is complete and stays; an import cut off while it was fetched is partial.
    if (!b.filename || (b.trigger === "import" && b.size != null)) continue;
    await fs.promises.rm(backupFile(b.serviceId, b.filename), { force: true }).catch(() => {});
    await db
      .update(schema.backup)
      .set({ filename: null })
      .where(and(eq(schema.backup.serviceId, b.serviceId), eq(schema.backup.filename, b.filename)));
  }

  // Decrypted copies of encrypted backups that a restart cut off mid-restore.
  for (const dir of await fs.promises.readdir(paths.backups).catch(() => []))
    for (const f of await fs.promises.readdir(path.join(paths.backups, dir)).catch(() => []))
      if (f.startsWith(".restoring-")) await fs.promises.rm(path.join(paths.backups, dir, f), { force: true }).catch(() => {});

  // Restores cut off by a restart: mark them failed, and start containers a storage restore stopped.
  // Only restores whose job was running when the worker stopped had stopped anything.
  const wasRunning = new Set(
    (stale as unknown as { type: string; payload: { backupId?: string } }[])
      .filter((j) => j.type === "backup.restore" || j.type === "backup.import")
      .map((j) => j.payload?.backupId),
  );
  const restores = await db
    .update(schema.backup)
    .set({ restoreStatus: "failed", restoredAt: new Date() })
    .where(and(eq(schema.backup.restoreStatus, "running"), notWaiting))
    .returning({ id: schema.backup.id, serviceId: schema.backup.serviceId, stopped: schema.backup.restoreStopped });
  for (const r of restores) {
    if (!wasRunning.has(r.id) || !r.stopped?.length) continue;
    const [service] = await db.select().from(schema.service).where(eq(schema.service.id, r.serviceId));
    const server = service ? await getServer(service.serverId).catch(() => null) : null;
    if (server) await startStoppedContainers(server.docker, r.stopped).catch(() => {});
    await db.update(schema.backup).set({ restoreStopped: null }).where(eq(schema.backup.id, r.id));
  }

  // Certificates interrupted mid-issue get another attempt.
  const certs = await db.update(schema.certificate).set({ status: "pending" }).where(eq(schema.certificate.status, "issuing")).returning({ id: schema.certificate.id });
  for (const c of certs) await enqueue("certificate.issue", { certificateId: c.id }, { concurrencyKey: `cert:${c.id}` });

  // Re-queue deployments that never got a job (e.g. created while the worker was down).
  const queued = await db.select().from(schema.deployment).where(eq(schema.deployment.status, "queued"));
  const pending = await db
    .select()
    .from(schema.job)
    .where(and(eq(schema.job.type, "deploy"), eq(schema.job.status, "pending")));
  const pendingIds = new Set(pending.map((j) => (j.payload as { deploymentId: string }).deploymentId));
  for (const d of queued) {
    if (!pendingIds.has(d.id)) await enqueue("deploy", { deploymentId: d.id }, { concurrencyKey: `service:${d.serviceId}` });
  }
}

/**
 * cli.json for the CLI on this host, checked again every 10 minutes so a removed or demoted admin
 * or a new Root organization is picked up (it only writes when something changed). A fresh install
 * has no admin yet: checked every minute until the first one signs up.
 */
async function startServerCli() {
  let last = "";
  const run = async () => {
    const line = await ensureServerCli();
    if (line !== last) log(line);
    last = line;
    if (!stopping) setTimeout(run, line.includes("no admin yet") ? 60_000 : 10 * 60_000).unref();
  };
  await run();
}

async function main() {
  if (process.argv.includes("--migrate")) {
    await runMigrations();
    log("Migrations applied");
    await sql.end({ timeout: 5 });
    process.exit(0);
  }
  log("Starting Serve worker");
  await runMigrations();
  log("Migrations applied");
  await docker.ping();
  await ensureNetwork();
  await recover();
  await startServerCli();
  try {
    await ensureProxy((l) => log(l));
    await syncLocalProxy();
    log("Proxy ready");
  } catch (error) {
    log("Proxy setup failed:", (error as Error).message);
  }
  // Remote servers take tens of seconds each over SSH: jobs start without waiting for them.
  void syncRemoteProxies((l) => log(l)).then(() => log("Remote proxies synced"));

  await sql.listen(JOB_CHANNEL, () => wake?.());
  await sql.listen(CANCEL_CHANNEL, (deploymentId) => {
    for (const r of running.values()) {
      if (r.job.type === "deploy" && (r.job.payload as { deploymentId: string }).deploymentId === deploymentId) {
        log(`Cancelling deployment ${deploymentId}`);
        r.controller.abort();
      }
    }
  });

  every(15_000, "heartbeat", () => updateSettings({ workerHeartbeat: new Date().toISOString(), workerSchemaVersion: SCHEMA_VERSION, workerVersion: currentVersion() }), true);
  // One loop: the status check never runs while the crash limit is stopping a replica.
  every(
    15_000,
    "monitor",
    async () => {
      // One container list per server serves both checks.
      const list = await containerLister();
      try {
        await monitorServices(list);
      } finally {
        await enforceCrashLimits(await reachableServers(), list);
      }
    },
    true,
  );
  every(60_000, "servers", probeRemoteServers, true);
  every(60_000, "host-ports", () => syncHostRelays((l) => log(l)));
  every(60_000, "tunnels", checkTunnels, true);
  // A GitHub App keeps the webhook address it was created with; follow dashboard domain changes.
  every(
    60 * 60_000,
    "github-app-hooks",
    async () => {
      const { syncAppWebhooks } = await import("@/server/git/github-app");
      const changed = await syncAppWebhooks();
      if (changed.length) log(`Pointed the webhook of ${changed.join(", ")} at this dashboard`);
    },
    true,
  );
  every(30_000, "metrics", collectMetrics, true);
  every(CHECK_INTERVAL_MS, "load-balancing", () => checkBalances((...a) => log(...a)), true);
  every(60_000, "metrics-agents", syncMetricsAgents, true);
  every(5 * 60_000, "metric-rollups", rollupRecent, true);
  every(60_000, "backups", scheduleBackups);
  every(60_000, "instance-backups", () => scheduleInstanceBackups((backupId) => enqueue("instance.backup", { backupId }, { concurrencyKey: "instance-backup" })));
  every(15_000, "update-status", reconcileUpdate, true);
  // Every minute: the check and auto-update schedules are cron expressions.
  every(60_000, "update-check", () => periodicUpdateCheck((to) => enqueue("instance.update", { to }, { concurrencyKey: "instance-update" })), true);
  every(60_000, "tasks", scheduleTasks);
  every(20_000, "analytics", ingestAccessLog, true);
  // Its own job, hourly: cleanup can be turned off, and the request log must still expire.
  every(60 * 60_000, "request-log", pruneRequestLog, true);
  every(6 * 3600_000, "certificates", renewDueCertificates, true);
  // A certificate that failed (its name did not resolve yet) is asked for again once it does.
  every(5 * 60_000, "certificate-retries", retryFailedCertificates);
  // Vector on each server, with the organizations' log drains and the names their lines carry.
  every(60_000, "log-drains", async () => (await import("@/server/log-drains/sync")).syncLogDrains(), true);
  every(5 * 60_000, "cleanup", scheduleCleanup, true);
  // Weekly per server: checks, and tells the organization about updates. Never installs.
  every(60 * 60_000, "os-updates", async () =>
    (await import("@/server/servers/os-updates")).weeklyOsUpdateCheck((serverId) =>
      enqueue("server.os-updates", { serverId, op: "check", notify: true }, { concurrencyKey: `server-os:${serverId}` }),
    ),
  );
  // Databases on domains: routes, certificates picked up after renewal, and containers that moved.
  every(5 * 60_000, "db-allowlists", async () => (await import("@/server/databases/allowlist")).syncDatabaseAllowlists(), true);
  every(5 * 60_000, "db-tunnels", async () => (await import("@/server/cloudflare/tunnels")).reattachDatabaseTunnels(), true);
  every(5 * 60_000, "proxy-health", checkProxies, true);
  // Servers that trust Cloudflare's proxy follow its published ranges; a failed fetch keeps the last list.
  every(
    60 * 60_000,
    "cloudflare-ranges",
    async () => {
      if (!(await anyServerTrustsCloudflare())) return;
      // A server that failed to apply new ranges is tried again every run until it succeeds (a restart syncs every proxy anyway).
      if ((await refreshCloudflareRanges().catch((e) => (log(`Cloudflare ranges: ${(e as Error).message}`), false))) || cloudflareSyncPending) {
        cloudflareSyncPending = !(await syncCloudflareTrusting(log));
      }
    },
    true,
  );
  // Private network: addresses for new services, servers that joined or left, agents that went missing.
  every(30_000, "mesh", () => syncMesh(), true);
  // Servers that connect out: the listener runs while any exist.
  every(10_000, "server-listener", () => syncTunnels(), true);
  // Uptime checks run every 15 s and pick the monitors that are due.
  every(15_000, "uptime", runUptimeChecks, true);
  // Backup proof: once a day, the newest backup of each database that asks for it is test-restored.
  every(10 * 60_000, "backup-proof", async () => {
    const { dueBackupTests } = await import("@/server/backups/verify");
    // Marked running when queued, like a test started by hand: the next tick does not queue it again.
    for (const backupId of await dueBackupTests()) {
      await db.update(schema.backup).set({ verifyStatus: "running" }).where(eq(schema.backup.id, backupId));
      await enqueue("backup.verify", { backupId }, { concurrencyKey: `backup-verify:${backupId}` });
    }
  });
  every(60_000, "status-maintenance", async () => {
    const { maintenanceTick, pruneSubscribers } = await import("@/server/status-pages/subscribers");
    await maintenanceTick();
    await pruneSubscribers();
  });
  // CLI sign-ins: tokens nobody collected, and sign-ins a day past their time.
  every(60_000, "cli-logins", pruneCliLogins);
  every(3600_000, "cloudflare-oauth", async () => (await import("@/server/cloudflare/oauth")).renewIdleOauth((l) => log(l)), true);
  // Servers in a tailnet: their address, and whether Tailscale sees them online.
  every(5 * 60_000, "tailscale", async () => (await import("@/server/tailscale")).syncTailscale(), true);
  every(60_000, "container-health", checkContainerHealth);
  every(60_000, "server-resources", checkServerResources);
  every(3600_000, "monitoring-prune", pruneMonitoring);
  every(30 * 60_000, "org-disk", measureOrgDisk, true);
  every(5 * 60_000, "org-limits", checkLimitNotices);
  // Quiet-hours summaries, lost retries and old delivery history.
  every(60_000, "notifications", async () => {
    await flushHeldNotifications();
    await retryDueDeliveries();
  });
  every(3600_000, "notifications-prune", pruneDeliveries);

  void loop();
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  log("Shutting down, waiting for running jobs...");
  const deadline = Date.now() + 25_000;
  while (running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  for (const r of running.values()) r.controller.abort();
  // Aborted deploys still put the previous version back and record the outcome: let them finish.
  const settled = Date.now() + 20_000;
  while (running.size && Date.now() < settled) await new Promise((r) => setTimeout(r, 250));
  shutdownTunnels();
  await updateSettings({ workerHeartbeat: null }).catch(() => {});
  await sql.end({ timeout: 5 });
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
