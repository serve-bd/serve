import type Docker from "dockerode";
import { imageExists, LABEL, pullImage } from "@/server/docker/client";
import type { VolumeMount } from "@/server/services/types";
import { volumeName } from "./containers";

/*
 * Images that declare VOLUME (postgres, mysql, redis, ...) keep their data there. Without a mount
 * Docker gives each new container a new anonymous volume, so every deploy would start empty.
 */

const HELPER_IMAGE = "alpine:3.22.6";

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** Paths the image declares with VOLUME. */
export async function imageVolumePaths(image: string, d: Docker): Promise<string[]> {
  const info = await d
    .getImage(image)
    .inspect()
    .catch(() => null);
  return Object.keys(info?.Config?.Volumes ?? {}).map(trim);
}

/** Whether one path is the other or contains it. */
function overlaps(a: string, b: string) {
  const [x, y] = [trim(a), trim(b)];
  return x === y || x === "/" || y === "/" || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** Declared paths no configured mount covers (the same path, or a parent or child of it). */
export function uncoveredPaths(declared: string[], volumes: Pick<VolumeMount, "mountPath">[]): string[] {
  return [...new Set(declared.map(trim))].filter((p) => !volumes.some((v) => overlaps(p, v.mountPath)));
}

/** Mounts on a path the image declares: the app keeps state there. */
export function statefulMounts(declared: string[], volumes: VolumeMount[]): VolumeMount[] {
  return volumes.filter((v) => v.kind !== "file" && declared.some((p) => overlaps(p, v.mountPath)));
}

/** Volume entries for uncovered paths, named after their last segment (unique among the service's volumes). */
export function volumesFor(paths: string[], volumes: VolumeMount[]): VolumeMount[] {
  const used = new Set(volumes.filter((v) => v.kind === "volume").map((v) => v.source));
  return paths.map((mountPath) => {
    const base =
      (mountPath.split("/").filter(Boolean).pop() ?? "data")
        .toLowerCase()
        .replace(/[^a-z0-9_.-]/g, "-")
        .replace(/^[^a-z0-9]+/, "") || "data";
    let source = base;
    for (let i = 2; used.has(source); i++) source = `${base}-${i}`;
    used.add(source);
    return { kind: "volume" as const, source, mountPath };
  });
}

/**
 * A container of the previous version that kept a now-mounted path in an anonymous volume (from
 * before Serve mounted it) has its data copied into the named volume, so the new version starts
 * with it. The previous version must be stopped. The anonymous volume itself is left in place.
 */
export async function adoptAnonymousVolumes(opts: { d: Docker; slug: string; serviceId: string; volumes: VolumeMount[]; old: { Id: string }[]; log: (line: string) => void }) {
  const { d, slug, volumes, log } = opts;
  const named = volumes.filter((v) => v.kind === "volume");
  if (!named.length || !opts.old.length) return;
  const mounts = (await d.getContainer(opts.old[0].Id).inspect()).Mounts ?? [];
  for (const v of named) {
    const target = volumeName(slug, v.source);
    const anon = mounts.find((m) => m.Type === "volume" && trim(m.Destination) === trim(v.mountPath) && m.Name && m.Name !== target && /^[0-9a-f]{64}$/.test(m.Name));
    if (!anon?.Name) continue;
    log(`Copying the data in ${v.mountPath} from the previous version's anonymous volume into volume ${target}`);
    if (!(await imageExists(HELPER_IMAGE, d))) await pullImage(HELPER_IMAGE, undefined, null, d);
    const helper = await d.createContainer({
      Image: HELPER_IMAGE,
      // The previous version is the source of truth: the named volume becomes an exact copy.
      Cmd: ["sh", "-c", "find /to -mindepth 1 -delete && cp -a /from/. /to/"],
      Labels: { [LABEL.managed]: "true", [LABEL.service]: opts.serviceId, [LABEL.kind]: "volume-copy" },
      HostConfig: { Binds: [`${anon.Name}:/from:ro`, `${target}:/to`], NetworkMode: "none" },
    });
    try {
      await helper.start();
      const result = (await helper.wait()) as { StatusCode: number };
      if (result.StatusCode !== 0) throw new Error(`Copying the data in ${v.mountPath} failed (exit code ${result.StatusCode}). The previous version keeps running.`);
    } finally {
      await helper.remove({ force: true }).catch(() => {});
    }
  }
}
