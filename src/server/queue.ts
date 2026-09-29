import { sql as dsql } from "drizzle-orm";
import { db, schema, sql } from "@/server/db";
import { newId } from "@/server/id";

export type JobType =
  | "deploy"
  | "service.stop"
  | "service.start"
  | "service.restart"
  | "service.delete"
  | "certificate.issue"
  | "certificate.renew-all"
  | "backup.run"
  | "backup.restore"
  | "proxy.sync"
  | "cleanup"
  | "task.run"
  | "server.setup";

export type JobPayloads = {
  deploy: { deploymentId: string };
  "service.stop": { serviceId: string };
  "service.start": { serviceId: string };
  "service.restart": { serviceId: string };
  "service.delete": { serviceId: string; slug: string; type: string; removeVolumes: boolean; environmentId?: string };
  "certificate.issue": { certificateId: string };
  "certificate.renew-all": Record<string, never>;
  "backup.run": { backupId: string };
  "backup.restore": { backupId: string };
  "proxy.sync": Record<string, never>;
  cleanup: { full?: boolean };
  "server.setup": { serverId: string; installDocker?: boolean };
  "task.run": { runId: string };
};

export type Job<T extends JobType = JobType> = Omit<typeof schema.job.$inferSelect, "payload" | "type"> & {
  type: T;
  payload: JobPayloads[T];
};

export const JOB_CHANNEL = "serve_jobs";
export const CANCEL_CHANNEL = "serve_cancel";

export async function enqueue<T extends JobType>(
  type: T,
  payload: JobPayloads[T],
  opts: { concurrencyKey?: string; runAt?: Date; maxAttempts?: number } = {},
) {
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

/** Claim the next runnable job, respecting per-key concurrency. */
export async function claimJob(
  excludeKeys: string[] = [],
  filter: { excludeTypes?: string[]; onlyTypes?: string[] } = {},
): Promise<Job | null> {
  const exclude = JSON.stringify(filter.excludeTypes ?? []);
  const only = filter.onlyTypes ? JSON.stringify(filter.onlyTypes) : null;
  const rows = await db.execute<typeof schema.job.$inferSelect & Record<string, unknown>>(dsql`
    UPDATE job SET status = 'running', locked_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT j.id FROM job j
      WHERE j.status = 'pending' AND j.run_at <= now()
        AND NOT (${exclude}::jsonb ? j.type)
        AND (${only}::jsonb IS NULL OR ${only}::jsonb ? j.type)
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
