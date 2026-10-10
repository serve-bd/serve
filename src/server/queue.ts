import { sql as dsql } from "drizzle-orm";
import { db, schema, sql } from "@/server/db";
import { newId } from "@/server/id";

/** What a restore takes from a backup and where it goes (see RestoreOptions in backups). */
export type RestoreChoice = {
  databases?: string[];
  renames?: Record<string, string>;
  tables?: string[];
  into?: string;
  /** An import of one database: restored into this database of the server. */
  intoDatabase?: string;
  /** An encrypted backup's passphrase, encrypted with Serve's key (job payloads are stored). */
  passphrase?: string;
};

/** Back up now with other settings than the saved ones, for that backup only. */
export type BackupChoice = {
  /** The main bucket (null: none) and more buckets for copies. */
  s3DestinationId?: string | null;
  copies?: string[];
  /** A copy stays on the server (only with a bucket). */
  local?: boolean;
  users?: boolean;
  /** false: not encrypted, though a passphrase is set. */
  encrypt?: boolean;
};

export type JobType =
  | "deploy"
  | "service.stop"
  | "service.start"
  | "service.restart"
  | "service.delete"
  | "certificate.issue"
  | "certificate.retire"
  | "certificate.renew-all"
  | "backup.run"
  | "backup.restore"
  | "backup.import"
  | "backup.verify"
  | "proxy.sync"
  | "status.notify"
  | "status.outage"
  | "cleanup"
  | "task.run"
  | "server.setup"
  | "server.os-updates"
  | "proxy.switch"
  | "instance.backup"
  | "instance.update"
  | "notification.deliver"
  | "environment.copy-data"
  | "preview.database"
  | "database.branch"
  | "mesh.sync"
  | "commit.status"
  | "tunnel.sync"
  | "cloudflare-tunnel.settle";

export type JobPayloads = {
  /** `force`: started at once, past the build server's slot limit (someone chose Force start). */
  deploy: { deploymentId: string; force?: boolean };
  "mesh.sync": Record<string, never>;
  /** Report a deployment's state on its commit; `status` is the state it was queued for. */
  "commit.status": { deploymentId: string; status: import("@/server/db/schema").DeploymentStatus };
  "tunnel.sync": Record<string, never>;
  /** After names moved between Cloudflare Tunnels: Cloudflare keeps sending them to the old tunnel for a few minutes, so its route goes only now. */
  "cloudflare-tunnel.settle": { sync: string[] };
  "service.stop": { serviceId: string };
  "service.start": { serviceId: string };
  "service.restart": { serviceId: string };
  "service.delete": {
    serviceId: string;
    slug: string;
    type: string;
    removeVolumes: boolean;
    environmentId?: string;
    serverId?: string;
    keepFiles?: boolean;
    keepServerFiles?: boolean;
    volumes?: string[];
    /** An app taken off one of its extra servers: skipped if it runs there again by then. */
    extraCleanup?: boolean;
  };
  "certificate.issue": { certificateId: string };
  "certificate.retire": { certificateId: string };
  "certificate.renew-all": Record<string, never>;
  "backup.run": { backupId: string; choice?: BackupChoice };
  "backup.verify": { backupId: string };
  "backup.restore": { backupId: string; users?: boolean } & RestoreChoice;
  /** receiveOnly: the file is fetched and checked, and restored later from the restore window. */
  "backup.import": { backupId: string; receiveOnly?: boolean; backupFirst?: boolean; users?: boolean; url?: string; s3?: { destinationId: string; key: string } } & RestoreChoice;
  "proxy.sync": Record<string, never>;
  /** A status page notice was posted or changed: tell its subscribers and team channels. */
  "status.notify": {
    noticeId: string;
    event: import("@/server/status-pages/subscribers").StatusEvent;
    notify?: boolean;
    /** Subscriber types and team channels picked for this post; left out: the page's defaults. */
    kinds?: import("@/lib/status-page").SubscriberKind[] | null;
    channels?: string[] | null;
  };
  /** An uptime check found a service down or back: status pages that send outages tell their subscribers. */
  "status.outage": { serviceId: string; incidentId: string };
  cleanup: { full?: boolean; serverId?: string };
  "server.setup": { serverId: string; installDocker?: boolean };
  "server.os-updates": { serverId: string; op: "check" | "install"; what?: "all" | string[]; notify?: boolean };
  "proxy.switch": { serverId: string; to: "nginx" | "caddy" | "traefik" | "none" };
  "task.run": { runId: string };
  "instance.backup": { backupId: string };
  "instance.update": { to: string };
  "notification.deliver": { deliveryId: string };
  "environment.copy-data": { environmentId: string; pairs: { from: string; to: string }[]; userId?: string | null };
  "database.branch": {
    branchId: string;
    op: "create" | "reset" | "delete";
    /** A pull request preview to deploy once its branch is ready. */
    preview?: { previewId: string; deployment: { commitSha?: string | null; commitMessage?: string | null; branch?: string | null } };
  };
  "preview.database": {
    previewId: string;
    databaseId: string;
    parentId: string;
    deployment: { commitSha?: string | null; commitMessage?: string | null; branch?: string | null };
  };
};

export type Job<T extends JobType = JobType> = Omit<typeof schema.job.$inferSelect, "payload" | "type"> & {
  type: T;
  payload: JobPayloads[T];
};

export const JOB_CHANNEL = "serve_jobs";
export const CANCEL_CHANNEL = "serve_cancel";

export async function enqueue<T extends JobType>(type: T, payload: JobPayloads[T], opts: { concurrencyKey?: string; runAt?: Date; maxAttempts?: number } = {}) {
  const id = newId();
  await db.insert(schema.job).values({
    id,
    type,
    payload,
    concurrencyKey: opts.concurrencyKey ?? null,
    runAt: opts.runAt ?? new Date(),
    maxAttempts: opts.maxAttempts ?? 1,
  });
  await sql.notify(JOB_CHANNEL, id).catch(() => {});
  return id;
}

/**
 * A deployment (d) of a service (s) that builds an image: git and Dockerfile apps, and compose
 * stacks (they may build some of their services). Rollbacks reuse an earlier image; image apps
 * only pull, and databases never build.
 */
export const BUILDS_SQL = `(d.rollback_of IS NULL AND (s.type = 'compose' OR (s.type = 'app' AND s.source->>'type' IN ('git', 'dockerfile', 'upload'))))`;
const BUILDS = dsql.raw(BUILDS_SQL);

/** Claim the next runnable job, respecting per-key concurrency. */
export async function claimJob(excludeKeys: string[] = [], filter: { excludeTypes?: string[]; onlyTypes?: string[]; fullBuildServers?: string[] } = {}): Promise<Job | null> {
  const exclude = JSON.stringify(filter.excludeTypes ?? []);
  const only = filter.onlyTypes ? JSON.stringify(filter.onlyTypes) : null;
  const fullServers = JSON.stringify(filter.fullBuildServers ?? []);
  const rows = await db.execute<typeof schema.job.$inferSelect & Record<string, unknown>>(dsql`
    UPDATE job SET status = 'running', locked_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT j.id FROM job j
      WHERE j.status = 'pending' AND j.run_at <= now()
        AND NOT (${exclude}::jsonb ? j.type)
        AND (${only}::jsonb IS NULL OR ${only}::jsonb ? j.type)
        -- A deploy waits only while its own build server is full; other servers keep building.
        -- One that builds nothing (a rollback, an image or a database) never waits for a slot.
        -- Force start skips that wait.
        AND NOT (
          j.type = 'deploy' AND COALESCE(j.payload->>'force', '') <> 'true' AND ${fullServers}::jsonb ? COALESCE((
            SELECT COALESCE(NULLIF(s.distribution->>'buildServerId', ''), s.server_id)
            FROM deployment d JOIN service s ON s.id = d.service_id
            WHERE d.id = j.payload->>'deploymentId' AND ${BUILDS}
          ), '')
        )
        AND (
          j.concurrency_key IS NULL OR (
            NOT EXISTS (
              SELECT 1 FROM job r WHERE r.status = 'running' AND r.concurrency_key = j.concurrency_key
            )
            AND NOT (${JSON.stringify(excludeKeys)}::jsonb ? j.concurrency_key)
          )
        )
      ORDER BY j.run_at, j.created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, type, payload, status, concurrency_key AS "concurrencyKey", attempts,
      max_attempts AS "maxAttempts", run_at AS "runAt", locked_at AS "lockedAt", error,
      created_at AS "createdAt", finished_at AS "finishedAt"
  `);
  return (rows[0] as unknown as Job) ?? null;
}

/**
 * The server that builds a deploy job's service, for counting build slots. Null when the deploy
 * builds nothing: it takes no slot.
 */
export async function buildServerForDeployment(deploymentId: string): Promise<string | null> {
  const rows = await db.execute<{ id: string | null }>(dsql`
    SELECT COALESCE(NULLIF(s.distribution->>'buildServerId', ''), s.server_id) AS id
    FROM deployment d JOIN service s ON s.id = d.service_id WHERE d.id = ${deploymentId} AND ${BUILDS}
  `);
  return (rows[0] as { id: string | null } | undefined)?.id ?? null;
}

export async function finishJob(id: string, error?: string | null) {
  await db.execute(dsql`
    UPDATE job SET
      status = CASE
        WHEN ${error ?? null}::text IS NULL THEN 'done'
        WHEN attempts < max_attempts THEN 'pending'
        ELSE 'failed' END,
      error = ${error ?? null},
      run_at = CASE WHEN ${error ?? null}::text IS NOT NULL THEN now() + (attempts * interval '30 seconds') ELSE run_at END,
      finished_at = now()
    WHERE id = ${id}
  `);
}

/**
 * A job that ran past its time limit: failed for good (another attempt would most likely hang the
 * same way), which frees its concurrency key. Only while it still runs: a handler that finished
 * meanwhile already recorded its outcome.
 */
export async function failJob(id: string, error: string) {
  await db.execute(dsql`
    UPDATE job SET status = 'failed', error = ${error}, finished_at = now()
    WHERE id = ${id} AND status = 'running'
  `);
}

/** Jobs left "running" by a crashed worker are marked failed on boot. */
export async function recoverStaleJobs() {
  return db.execute(dsql`
    UPDATE job SET status = 'failed', error = 'Worker restarted while the job was running', finished_at = now()
    WHERE status = 'running'
    RETURNING id, type, payload
  `);
}

export async function pruneJobs() {
  await db.execute(dsql`
    DELETE FROM job WHERE status IN ('done', 'failed') AND created_at < now() - interval '7 days'
  `);
}
