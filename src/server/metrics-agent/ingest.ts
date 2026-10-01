import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/server/db";
import { type AgentSnapshot, LOCAL_SERVER_ID, type ServerAgent } from "@/server/db/schema";
import { metricsCutoff } from "@/lib/server-limits";
import { rollupRange } from "@/server/metric-rollups";

/* What agent/main.go sends: samples of the machine and of each service, numbered per agent run. */

const count = z.number().finite().nonnegative();

const sampleSchema = z.object({
  seq: z.number().int().positive(),
  t: z.number().int().positive(),
  host: z.object({
    cpu: count,
    cores: z.number().int().nonnegative(),
    memTotal: count,
    memUsed: count,
    disk: count,
    diskTotal: count,
    load: z.array(z.number().finite()).max(3),
    uptime: count,
  }),
  services: z.array(z.object({ id: z.string().min(1).max(64), cpu: count, memory: count, memoryLimit: count, rx: count, tx: count })).max(5000),
});

const containerSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().max(256),
  service: z.string().max(64),
  deployment: z.string().max(64).optional(),
  state: z.string().max(32),
  restartCount: z.number().int().nonnegative(),
  startedAt: z.string().max(64).optional(),
  created: z.number().int().nonnegative(),
  oomKilled: z.boolean().optional(),
  exitCode: z.number().int(),
});

export const batchSchema = z.object({
  boot: z.string().min(1).max(64),
  version: z.string().max(64),
  samples: z.array(sampleSchema).max(2880),
  containers: z.array(containerSchema).max(5000).optional(),
  containersAt: z.number().int().positive().optional(),
});

export type AgentBatch = z.infer<typeof batchSchema>;

export type IngestResult = { ack: number; stored: number; oldest: number | null } | { gone: true };

/**
 * Stores a batch from a server's agent, once: each run of the agent numbers its samples, and the
 * server row remembers the last stored number, so a batch that arrives twice (pushed, then
 * collected over SSH) is not stored again. The answer acknowledges everything up to `ack`.
 */
export async function ingestBatch(serverId: string, batch: AgentBatch, via: "push" | "ssh", now = Date.now()): Promise<IngestResult> {
  const result = await store(serverId, batch, via, now);
  // Samples held back while the server was offline: the rollup job only looks at the last half hour.
  if (!("gone" in result) && result.oldest !== null && result.oldest < now - 20 * 60_000) await rollupRange(new Date(result.oldest), new Date(now));
  return result;
}

async function store(serverId: string, batch: AgentBatch, via: "push" | "ssh", now: number): Promise<IngestResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ agent: schema.server.agent, enabled: schema.server.metricsEnabled, hours: schema.server.metricsRetentionHours })
      .from(schema.server)
      .where(eq(schema.server.id, serverId))
      .for("update");
    if (!row) throw new Error("Server not found.");
    if (!row.enabled) return { gone: true as const };
    const agent = row.agent;
    const after = agent?.boot === batch.boot ? (agent.seq ?? 0) : 0;
    const fresh = batch.samples.filter((s) => s.seq > after).sort((a, b) => a.seq - b.seq);
    const ack = Math.max(after, ...batch.samples.map((s) => s.seq));

    const cutoff = metricsCutoff(Math.min(row.hours, RAW_HOURS), now).getTime();
    const ids = [...new Set(fresh.flatMap((s) => s.services.map((x) => x.id)))];
    // Only this server's services: an extra server of a distributed service reports it too.
    const owned = ids.length
      ? new Set(
          (
            await tx
              .select({ id: schema.service.id })
              .from(schema.service)
              .where(and(inArray(schema.service.id, ids), eq(schema.service.serverId, serverId)))
          ).map((r) => r.id),
        )
      : new Set<string>();
    const scope = serverId === LOCAL_SERVER_ID ? "server" : `server:${serverId}`;
    const rows: (typeof schema.metric.$inferInsert)[] = [];
    let oldest: number | null = null;
    for (const s of fresh) {
      // A stamp from the future (the server's clock is ahead) counts as now.
      const t = Math.min(s.t, now);
      if (t < cutoff) continue;
      oldest = oldest === null ? t : Math.min(oldest, t);
      const createdAt = new Date(t);
      rows.push({
        scope,
        cpu: Math.round(s.host.cpu * 100),
        memory: Math.round(s.host.memUsed),
        memoryLimit: Math.round(s.host.memTotal),
        disk: Math.round(s.host.disk),
        diskTotal: Math.round(s.host.diskTotal),
        createdAt,
      });
      for (const x of s.services) {
        if (!owned.has(x.id)) continue;
        rows.push({
          scope: x.id,
          cpu: Math.round(x.cpu * 100),
          memory: Math.round(x.memory),
          memoryLimit: Math.round(x.memoryLimit),
          netRx: Math.round(x.rx),
          netTx: Math.round(x.tx),
          createdAt,
        });
      }
    }
    for (let i = 0; i < rows.length; i += 1000) await tx.insert(schema.metric).values(rows.slice(i, i + 1000));

    const last = fresh.at(-1);
    const snapshot: AgentSnapshot | null | undefined = last
      ? {
          at: new Date(Math.min(last.t, now)).toISOString(),
          cpu: last.host.cpu,
          cores: last.host.cores,
          memory: { total: last.host.memTotal, used: last.host.memUsed },
          disk: { total: last.host.diskTotal, used: last.host.disk },
          load: last.host.load,
          uptime: last.host.uptime,
        }
      : agent?.snapshot;
    // Batches can arrive out of order (pushed and collected over SSH): only a newer check counts.
    const containersAt = batch.containersAt && batch.containers ? Math.min(batch.containersAt, now) : null;
    const newer = containersAt !== null && (!agent?.containersAt || containersAt > new Date(agent.containersAt).getTime());
    const next: ServerAgent = {
      image: agent?.image ?? "",
      tokenHash: agent?.tokenHash ?? "",
      installedAt: agent?.installedAt ?? new Date(now).toISOString(),
      ...agent,
      boot: batch.boot,
      seq: ack,
      seenAt: new Date(now).toISOString(),
      via,
      version: batch.version || null,
      snapshot,
      ...(newer ? { containers: batch.containers, containersAt: new Date(containersAt).toISOString() } : {}),
    };
    await tx.update(schema.server).set({ agent: next }).where(eq(schema.server.id, serverId));
    return { ack, stored: fresh.length, oldest };
  });
}

/** Raw samples are kept this long at most; older history is in five-minute averages. */
export const RAW_HOURS = 48;
