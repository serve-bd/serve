import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import type { DbEngine } from "@/server/services/types";

/** A Docker volume name (what `docker volume create` accepts). Checked before any Docker call. */
export const VOLUME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;

export type KeptKind = "database" | "volume";

/** Data a deleted service left on its server, as the canvas and the API show it (never the database's password). */
export type KeptData = {
  kind: KeptKind;
  id: string;
  /** Docker volume name, or an absolute host path (databases on a folder). */
  volume: string;
  /** The deleted service's name and kind. */
  serviceName: string;
  serviceType: "database" | "app" | "compose";
  engine: DbEngine | null;
  version: string | null;
  mountPath: string | null;
  /** Made by Serve: deleting the data deletes the volume. */
  owned: boolean;
  /** Last measured size; null when not known. */
  bytes: number | null;
  serverId: string;
  serverName: string;
  createdAt: Date;
};

/** What the services of an environment left behind, newest first. Scoped to the organization. */
export async function environmentKept(environmentId: string, organizationId: string): Promise<KeptData[]> {
  const [dbs, vols] = await Promise.all([
    db
      .select({
        id: schema.keptDatabase.id,
        volume: schema.keptDatabase.volume,
        serviceName: schema.keptDatabase.name,
        engine: schema.keptDatabase.engine,
        version: schema.keptDatabase.version,
        mountPath: schema.keptDatabase.dataMountPath,
        owned: schema.keptDatabase.owned,
        serverId: schema.keptDatabase.serverId,
        createdAt: schema.keptDatabase.createdAt,
      })
      .from(schema.keptDatabase)
      .where(and(eq(schema.keptDatabase.environmentId, environmentId), eq(schema.keptDatabase.organizationId, organizationId))),
    db
      .select()
      .from(schema.keptVolume)
      .where(and(eq(schema.keptVolume.environmentId, environmentId), eq(schema.keptVolume.organizationId, organizationId))),
  ]);
  const serverIds = [...new Set([...dbs, ...vols].map((r) => r.serverId))];
  if (!serverIds.length) return [];
  const [servers, sizes] = await Promise.all([
    db.select({ id: schema.server.id, name: schema.server.name }).from(schema.server).where(inArray(schema.server.id, serverIds)),
    db.select().from(schema.volumeSize).where(inArray(schema.volumeSize.serverId, serverIds)),
  ]);
  const sizeOf = (serverId: string, name: string) => sizes.find((x) => x.serverId === serverId && x.name === name)?.bytes ?? null;
  const serverName = (id: string) => servers.find((x) => x.id === id)?.name ?? "";
  return [
    ...dbs.map(
      (r): KeptData => ({
        kind: "database",
        id: r.id,
        volume: r.volume,
        serviceName: r.serviceName,
        serviceType: "database",
        engine: r.engine,
        version: r.version,
        mountPath: r.mountPath,
        owned: r.owned,
        bytes: r.volume.startsWith("/") ? null : sizeOf(r.serverId, r.volume),
        serverId: r.serverId,
        serverName: serverName(r.serverId),
        createdAt: r.createdAt,
      }),
    ),
    ...vols.map(
      (r): KeptData => ({
        kind: "volume",
        id: r.id,
        volume: r.volume,
        serviceName: r.serviceName,
        serviceType: r.serviceType,
        engine: null,
        version: null,
        mountPath: r.mountPath,
        owned: r.owned,
        bytes: sizeOf(r.serverId, r.volume),
        serverId: r.serverId,
        serverName: serverName(r.serverId),
        createdAt: r.createdAt,
      }),
    ),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
