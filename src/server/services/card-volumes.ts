import { volumeName } from "@/server/deploy/containers";
import { engines } from "@/server/databases/engines";
import type { DatabaseConfig, RuntimeConfig, VolumeMount } from "@/server/services/types";

/** A volume on a service's canvas card. `bind`: a host folder (name is its path), never sized. */
export type CardVolume = { name: string; mountPath: string | null; bytes: number | null; bind: boolean };

type Size = { serverId: string; name: string; composeProject: string | null; bytes: number };

/**
 * The volumes a service keeps its data in, with their last measured size. Apps: their named
 * volumes and host folders. Databases: the data volume (their own, one made outside Serve, or a
 * folder) and any added in Persistent storage. Stacks: the volumes compose labelled with their
 * project (the slug), known once sizes were measured.
 */
export function cardVolumes(
  s: { type: string; slug: string; serverId: string; runtime: Pick<RuntimeConfig, "volumes">; database: DatabaseConfig | null },
  sizes: Size[],
): CardVolume[] {
  const onServer = sizes.filter((x) => x.serverId === s.serverId);
  if (s.type === "compose")
    return onServer
      .filter((x) => x.composeProject === s.slug)
      .map((x) => ({ name: x.name, mountPath: null, bytes: x.bytes, bind: false }))
      .sort((a, b) => a.name.localeCompare(b.name));
  let mounts = s.runtime.volumes ?? [];
  if (s.type === "database" && s.database) {
    // As the deploy mounts it (deploy/index.ts): the data volume first.
    const cfg = s.database;
    const mountPath = cfg.dataMountPath?.trim() || engines[cfg.engine].dataPath;
    const data: VolumeMount = !cfg.dataVolume
      ? { kind: "volume", source: "data", mountPath }
      : cfg.dataVolume.startsWith("/")
        ? { kind: "bind", source: cfg.dataVolume, mountPath }
        : { kind: "volume", source: cfg.dataVolume, mountPath, external: true };
    mounts = [data, ...mounts.filter((v) => !(v.kind === "volume" && v.source === "data" && !v.external))];
  }
  return mounts.flatMap((v): CardVolume[] => {
    if (v.kind === "bind") return [{ name: v.source, mountPath: v.mountPath, bytes: null, bind: true }];
    if (v.kind !== "volume") return [];
    const name = v.external ? v.source : volumeName(s.slug, v.source);
    return [{ name, mountPath: v.mountPath, bytes: onServer.find((x) => x.name === name)?.bytes ?? null, bind: false }];
  });
}
