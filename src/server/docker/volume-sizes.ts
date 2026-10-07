import { and, eq, notInArray, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";

/** A server that does not answer `docker system df` in time is skipped this round. */
const SERVER_MS = 5 * 60_000;

type DfVolume = { Name: string; Labels?: Record<string, string> | null; UsageData?: { Size?: number } | null };

/**
 * Worker tick: the size of every Docker volume on each reachable server, for the canvas. Sizes are
 * informational only. Servers are measured side by side; one that fails keeps its last sizes and
 * does not stop the others.
 */
export async function measureVolumeSizes() {
  const { getServer } = await import("@/server/servers/context");
  const { withTimeout } = await import("@/server/monitoring/containers");
  const servers = await db.select({ id: schema.server.id, name: schema.server.name, isLocal: schema.server.isLocal, status: schema.server.status }).from(schema.server);
  const failures: string[] = [];
  await Promise.all(
    servers
      .filter((s) => s.isLocal || s.status === "ready")
      .map(async (s) => {
        try {
          await withTimeout(
            getServer(s.id).then(async (ctx) => saveSizes(s.id, ((await ctx.docker.df()) as { Volumes?: DfVolume[] | null }).Volumes ?? [])),
            SERVER_MS,
          );
        } catch (e) {
          failures.push(`${s.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }),
  );
  if (failures.length) throw new Error(failures.join("; "));
}

async function saveSizes(serverId: string, volumes: DfVolume[]) {
  const checkedAt = new Date();
  // Docker reports -1 (or nothing) when it has not measured a volume: its last size stays.
  const rows = volumes
    .filter((v) => v.Name && typeof v.UsageData?.Size === "number" && v.UsageData.Size >= 0)
    .map((v) => ({ serverId, name: v.Name, composeProject: v.Labels?.["com.docker.compose.project"] ?? null, bytes: v.UsageData!.Size!, checkedAt }));
  if (rows.length)
    await db
      .insert(schema.volumeSize)
      .values(rows)
      .onConflictDoUpdate({
        target: [schema.volumeSize.serverId, schema.volumeSize.name],
        set: { bytes: sql`excluded.bytes`, composeProject: sql`excluded.compose_project`, checkedAt },
      });
  // Volumes no longer on the server.
  const present = volumes.map((v) => v.Name).filter(Boolean);
  await db.delete(schema.volumeSize).where(and(eq(schema.volumeSize.serverId, serverId), present.length ? notInArray(schema.volumeSize.name, present) : undefined));
}
