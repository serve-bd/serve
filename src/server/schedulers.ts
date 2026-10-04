import { sql } from "drizzle-orm";
import { db, schema } from "@/server/db";

/** Records how a run of one of the worker's repeating schedulers went (for Settings → Jobs). Best effort. */
export async function recordSchedulerRun(name: string, intervalMs: number, startedAt: Date, error: string | null) {
  const now = new Date();
  const t = schema.schedulerRun;
  await db
    .insert(t)
    .values({
      name,
      intervalMs,
      lastStartedAt: startedAt,
      lastFinishedAt: now,
      lastDurationMs: now.getTime() - startedAt.getTime(),
      lastError: error,
      lastFailedAt: error ? now : null,
      runs: 1,
      failures: error ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: t.name,
      set: {
        intervalMs,
        lastStartedAt: startedAt,
        lastFinishedAt: now,
        lastDurationMs: now.getTime() - startedAt.getTime(),
        lastError: error,
        lastFailedAt: error ? now : sql`${t.lastFailedAt}`,
        runs: sql`${t.runs} + 1`,
        failures: error ? sql`${t.failures} + 1` : sql`${t.failures}`,
      },
    })
    .catch(() => {});
}

/** A tick left out because the scheduler's previous run is still going. */
export async function recordSchedulerSkip(name: string, intervalMs: number) {
  const now = new Date();
  const t = schema.schedulerRun;
  await db
    .insert(t)
    .values({ name, intervalMs, skipped: 1, lastSkippedAt: now })
    .onConflictDoUpdate({ target: t.name, set: { skipped: sql`${t.skipped} + 1`, lastSkippedAt: now } })
    .catch(() => {});
}
