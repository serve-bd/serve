import { sql } from "drizzle-orm";
import { db } from "@/server/db";

/** Width of one rollup bucket. */

/** Metric scope for an app's replicas on one of its extra servers (added to its own in charts). */
export const extraScope = (serviceId: string, serverId: string) => `${serviceId}@${serverId}`;

export const ROLLUP_MINUTES = 5;
/** Charts over more hours than this read the rollups. */
export const ROLLUP_ABOVE_HOURS = 24;

/**
 * Averages the raw samples between two moments into five-minute buckets (updated in place, so
 * running it again over the same span, or after late samples arrived, is harmless). The bucket
 * still filling up is left for a later run.
 */
export async function rollupRange(from: Date, to: Date = new Date()) {
  await db.execute(sql`
    INSERT INTO metric_rollup (scope, bucket, cpu, memory, memory_limit, net_rx, net_tx, disk, disk_total)
    SELECT scope, date_bin(${`${ROLLUP_MINUTES} minutes`}::interval, created_at, TIMESTAMPTZ '2000-01-01') AS bucket,
      round(avg(cpu))::int, round(avg(memory))::bigint, max(memory_limit), max(net_rx), max(net_tx), round(avg(disk))::bigint, max(disk_total)
    FROM metric
    WHERE created_at >= date_bin(${`${ROLLUP_MINUTES} minutes`}::interval, ${from.toISOString()}::timestamptz, TIMESTAMPTZ '2000-01-01')
      AND created_at < date_bin(${`${ROLLUP_MINUTES} minutes`}::interval, ${to.toISOString()}::timestamptz, TIMESTAMPTZ '2000-01-01')
    GROUP BY 1, 2
    ON CONFLICT (scope, bucket) DO UPDATE SET
      cpu = excluded.cpu, memory = excluded.memory, memory_limit = excluded.memory_limit, net_rx = excluded.net_rx,
      net_tx = excluded.net_tx, disk = excluded.disk, disk_total = excluded.disk_total
  `);
}

/** Worker job: the last half hour, which also takes in samples that arrived a little late. */
export async function rollupRecent() {
  await rollupRange(new Date(Date.now() - 30 * 60_000));
}
