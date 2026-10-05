import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/server/db";
import { type AgentSnapshot, LOCAL_SERVER_ID, type ServerAgent } from "@/server/db/schema";
import { metricsCutoff } from "@/lib/server-limits";
import { extraScope, rollupRange } from "@/server/metric-rollups";

/* What agent/main.go sends: samples of the machine and of each service, numbered per agent run. */

const count = z.number().finite().nonnegative();

/** A list whose bad entries are dropped: one odd container label would otherwise reject the whole batch. */
const validOnly = <T extends z.ZodType>(item: T, max: number) => z.preprocess((v) => (Array.isArray(v) ? v.filter((x) => item.safeParse(x).success) : v), z.array(item).max(max));

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
  services: validOnly(z.object({ id: z.string().min(1).max(64), cpu: count, memory: count, memoryLimit: count, rx: count, tx: count }), 5000),
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
  containers: validOnly(containerSchema, 5000).optional(),
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
    // This server's services, and the apps it runs as an extra server ("<service>@<server>", added
    // to the service's own in its charts). Containers of anything else (another Serve) are skipped.
    const scopes = new Map<string, string>();
    if (ids.length) {
      const found = await tx
        .select({ id: schema.service.id, serverId: schema.service.serverId, distribution: schema.service.distribution })
        .from(schema.service)
        .where(inArray(schema.service.id, ids));
      for (const r of found) {
        if (r.serverId === serverId) scopes.set(r.id, r.id);
        else if (r.distribution?.extraServerIds?.includes(serverId)) scopes.set(r.id, extraScope(r.id, serverId));
      }
    }
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
        const own = scopes.get(x.id);
        if (!own) continue;
        rows.push({
          scope: own,
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
    // The agent leaves out an empty list (Go's omitempty): a check with a time and no list found none.
    const containers = batch.containersAt ? (batch.containers ?? []) : undefined;
    const containersAt = batch.containersAt && containers ? Math.min(batch.containersAt, now) : null;
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
      ...(newer ? { containers, containersAt: new Date(containersAt).toISOString() } : {}),
    };
    await tx.update(schema.server).set({ agent: next }).where(eq(schema.server.id, serverId));
    return { ack, stored: fresh.length, oldest };
  });
}

/** Raw samples are kept this long at most; older history is in five-minute averages. */
export const RAW_HOURS = 48;
