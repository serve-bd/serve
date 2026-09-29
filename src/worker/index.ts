import "dotenv/config";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { ProxyKind } from "@/server/proxy/config";
import { CronExpressionParser } from "cron-parser";
import { db, schema, sql } from "@/server/db";
import { runMigrations } from "@/server/db/migrate";
import { newId } from "@/server/id";
import { docker, ensureNetwork, LABEL, listServiceContainers } from "@/server/docker/client";
import { ensureProxy, ensureServerProxy, syncAllProxy } from "@/server/proxy/nginx";
import { CANCEL_CHANNEL, claimJob, enqueue, finishJob, JOB_CHANNEL, recoverStaleJobs, type Job, type JobPayloads } from "@/server/queue";
import { runDeployment, setServiceStatus } from "@/server/deploy";
import { destroyService, restartService, startService, stopService } from "@/server/services/lifecycle";
import { issueCertificate, renewDueCertificates } from "@/server/ssl/certificates";
import { importBackup, restoreBackup, runBackup } from "@/server/backups";
import { collectMetrics } from "@/server/metrics";
import { getSettings, updateSettings } from "@/server/settings";
import { notify, orgOfService } from "@/server/notify";
import { runTask, scheduleTasks } from "@/server/services/tasks";
import { ingestAccessLog } from "@/server/analytics";
import { runCleanup, scheduleCleanup } from "@/server/cleanup";
import { probeServer, setupServer } from "@/server/servers/setup";
import { getServer, serverOf } from "@/server/servers/context";
import { SCHEMA_VERSION } from "@/server/version";
import { checkTunnels } from "@/server/cloudflare/tunnels";

const log = (...args: unknown[]) => console.log(`[worker ${new Date().toISOString()}]`, ...args);

const running = new Map<string, { job: Job; controller: AbortController }>();
let wake: (() => void) | null = null;
let stopping = false;

async function handle(job: Job, signal: AbortSignal) {
  const p = job.payload as Record<string, string>;
  switch (job.type) {
    case "deploy":
      return runDeployment(p.deploymentId, signal);
    case "service.stop":
      return stopService(p.serviceId);
    case "service.start":
      return void (await startService(p.serviceId));
    case "service.restart":
      return restartService(p.serviceId);
    case "service.delete":
      return destroyService(job.payload as never);
    case "certificate.issue":
      return issueCertificate(p.certificateId);
    case "certificate.renew-all":
      return renewDueCertificates();
    case "backup.run":
      return runBackup(p.backupId);
    case "backup.restore":
      return void (await restoreBackup(p.backupId));
    case "backup.import": {
      const { backupId, ...opts } = job.payload as JobPayloads["backup.import"];
      return importBackup(backupId, opts);
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
    case "proxy.switch": {
      const { switchProxy } = await import("@/server/proxy/switch");
      return switchProxy(p.serverId, p.to as ProxyKind);
    }
  }
}

async function execute(job: Job) {
  const controller = new AbortController();
  running.set(job.id, { job, controller });
  const started = Date.now();
  try {
    await handle(job, controller.signal);
    await finishJob(job.id, null);
    log(`${job.type} ${job.id} done in ${Date.now() - started}ms`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishJob(job.id, message.slice(0, 4000));
    log(`${job.type} ${job.id} failed: ${message.split("\n")[0]}`);
  } finally {
    running.delete(job.id);
    wake?.();
  }
}

async function loop() {
  while (!stopping) {
    const settings = await getSettings().catch(() => null);
    const buildLimit = Math.max(1, settings?.buildConcurrency ?? 2);
    const deploys = [...running.values()].filter((r) => r.job.type === "deploy").length;
    const others = running.size - deploys;
    let claimed = false;

    const buildsFull = deploys >= buildLimit;
    const othersFull = others >= 4;
    if (!(buildsFull && othersFull)) {
      const busyKeys = [...running.values()].map((r) => r.job.concurrencyKey).filter(Boolean) as string[];
      try {
        // Only ask for job types that have a free slot, so a waiting build never blocks other work.
        const job = await claimJob(busyKeys, buildsFull ? { excludeTypes: ["deploy"] } : othersFull ? { onlyTypes: ["deploy"] } : {});
        if (job) {
          claimed = true;
          void execute(job);
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
    if (busy || stopping) return;
    busy = true;
    try {
      await fn();
    } catch (error) {
      log(`${name} failed:`, (error as Error).message);
    } finally {
      busy = false;
    }
  };
  if (runNow) void tick();
  return setInterval(tick, ms);
}

/** Keeps remote server status fresh (ready / unreachable). */
async function probeRemoteServers() {
  const rows = await db.select({ id: schema.server.id, status: schema.server.status }).from(schema.server).where(eq(schema.server.isLocal, false));
  await Promise.all(rows.filter((r) => r.status === "ready" || r.status === "unreachable").map((r) => probeServer(r.id)));
}

/** Servers whose Docker can be asked right now: the local one and ready remote ones. */
async function reachableServers() {
  const rows = await db.select({ id: schema.server.id, isLocal: schema.server.isLocal, status: schema.server.status }).from(schema.server);
  return new Set(rows.filter((r) => r.isLocal || r.status === "ready").map((r) => r.id));
}

/** Detect crashed or recovered services by looking at their containers. */
async function monitorServices() {
  const services = await db
    .select()
    .from(schema.service)
    .where(inArray(schema.service.status, ["running", "crashed", "restarting"]));
  const reachable = await reachableServers();
  for (const s of services) {
    // An unreachable server says nothing about its services; keep their last known status.
    if (!reachable.has(s.serverId)) continue;
    let containers;
    try {
      const server = await serverOf(s);
      containers = await listServiceContainers(s.id, true, server.docker);
    } catch {
      continue;
    }
    const relevant =
      s.type === "app" ? containers.filter((c) => c.Labels[LABEL.deployment] === s.currentDeploymentId) : containers;
    // Every container is gone (removed by hand or by a Docker reset).
    if (!relevant.length) {
      if (s.status === "crashed") continue;
      await setServiceStatus(s.id, "crashed");
      void notify(await orgOfService(s.id), "service.crashed", {
        ok: false,
        title: `${s.name} has no containers`,
        body: "Its containers were removed outside Serve. Deploy or restart it to recreate them.",
        url: `/projects/${s.projectId}/services/${s.id}`,
      });
      continue;
    }
    const up = relevant.filter((c) => c.State === "running");
    const restarting = relevant.some((c) => c.State === "restarting");
    const next = up.length === relevant.length ? "running" : restarting ? "restarting" : up.length ? "running" : "crashed";
    if (next !== s.status) {
      await setServiceStatus(s.id, next);
      if (next === "crashed") {
        void notify(await orgOfService(s.id), "service.crashed", {
          ok: false,
          title: `${s.name} crashed`,
          body: "All containers for this service have stopped.",
          url: `/projects/${s.projectId}/services/${s.id}`,
        });
      }
    }
  }
}

/** Restarts a stopped or missing proxy on every reachable server. */
async function checkProxies() {
  const reachable = await reachableServers();
  for (const id of reachable) {
    try {
      const server = await getServer(id);
      const info = await server.docker.getContainer(server.proxyContainer).inspect().catch(() => null);
      if (!info?.State.Running) await ensureServerProxy(server, (l) => log(`[${server.name}] ${l}`));
    } catch (error) {
      log(`proxy check on ${id} failed:`, (error as Error).message);
    }
  }
}

const lastBackupRun = new Map<string, number>();

async function scheduleBackups() {
  const services = await db
    .select()
    .from(schema.service)
    .where(and(eq(schema.service.type, "database"), isNotNull(schema.service.database)));
  const now = new Date();
  const tz = (await getSettings()).timezone;
  for (const s of services) {
    const cron = s.database?.backupSchedule;
    if (!cron) continue;
    try {
      const prev = CronExpressionParser.parse(cron, { currentDate: now, tz }).prev().toDate().getTime();
      // Fire if the previous occurrence happened within the last minute and was not handled yet.
      if (now.getTime() - prev < 60_000 && lastBackupRun.get(s.id) !== prev) {
        lastBackupRun.set(s.id, prev);
        const id = newId();
        await db.insert(schema.backup).values({ id, serviceId: s.id, trigger: "schedule" });
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
  const stale = await recoverStaleJobs();
  if (stale.length) log(`Recovered ${stale.length} interrupted job(s)`);
  const stuck = await db
    .update(schema.deployment)
    .set({ status: "failed", error: "The worker restarted during this deployment.", finishedAt: new Date() })
    .where(inArray(schema.deployment.status, ["building", "deploying"]))
    .returning({ serviceId: schema.deployment.serviceId });
  for (const { serviceId } of stuck) {
    const [service] = await db.select({ serverId: schema.service.serverId }).from(schema.service).where(eq(schema.service.id, serviceId));
    const server = service ? await getServer(service.serverId).catch(() => null) : null;
    const up = server ? (await listServiceContainers(serviceId, false, server.docker).catch(() => [])).length > 0 : false;
    await setServiceStatus(serviceId, up ? "running" : "failed");
  }
  // Certificates interrupted mid-issue get another attempt.
  const certs = await db
    .update(schema.certificate)
    .set({ status: "pending" })
    .where(eq(schema.certificate.status, "issuing"))
    .returning({ id: schema.certificate.id });
  for (const c of certs) await enqueue("certificate.issue", { certificateId: c.id }, { concurrencyKey: `cert:${c.id}` });

  // Re-queue deployments that never got a job (e.g. created while the worker was down).
  const queued = await db.select().from(schema.deployment).where(eq(schema.deployment.status, "queued"));
  const pending = await db.select().from(schema.job).where(and(eq(schema.job.type, "deploy"), eq(schema.job.status, "pending")));
  const pendingIds = new Set(pending.map((j) => (j.payload as { deploymentId: string }).deploymentId));
  for (const d of queued) {
    if (!pendingIds.has(d.id)) await enqueue("deploy", { deploymentId: d.id }, { concurrencyKey: `service:${d.serviceId}` });
  }
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
  try {
    await ensureProxy((l) => log(l));
    await syncAllProxy();
    log("Proxy ready");
  } catch (error) {
    log("Proxy setup failed:", (error as Error).message);
  }

  await sql.listen(JOB_CHANNEL, () => wake?.());
  await sql.listen(CANCEL_CHANNEL, (deploymentId) => {
    for (const r of running.values()) {
      if (r.job.type === "deploy" && (r.job.payload as { deploymentId: string }).deploymentId === deploymentId) {
        log(`Cancelling deployment ${deploymentId}`);
        r.controller.abort();
      }
    }
  });

  every(15_000, "heartbeat", () => updateSettings({ workerHeartbeat: new Date().toISOString(), workerSchemaVersion: SCHEMA_VERSION }), true);
  every(15_000, "monitor", monitorServices, true);
  every(60_000, "servers", probeRemoteServers, true);
  every(60_000, "tunnels", checkTunnels, true);
  every(30_000, "metrics", collectMetrics, true);
  every(60_000, "backups", scheduleBackups);
  every(60_000, "tasks", scheduleTasks);
  every(20_000, "analytics", ingestAccessLog, true);
  every(6 * 3600_000, "certificates", renewDueCertificates, true);
  every(5 * 60_000, "cleanup", scheduleCleanup, true);
  every(5 * 60_000, "proxy-health", checkProxies, true);

  void loop();
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  log("Shutting down, waiting for running jobs...");
  const deadline = Date.now() + 25_000;
  while (running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  for (const r of running.values()) r.controller.abort();
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
