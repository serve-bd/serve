import fs from "node:fs";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import type Docker from "dockerode";
import { imageExists, LABEL, pullImage } from "@/server/docker/client";

/** Small image that packs and unpacks storage; pinned like every image Serve runs itself. */
export const STORAGE_HELPER_IMAGE = "alpine:3.22.6";

/** A volume or a host directory that containers of a stack mount. */
export type StorageSource = { kind: "volume" | "dir"; source: string; containers: string[]; destinations: string[] };

/** Paths never offered for a storage backup: Docker's own socket and the like. */
const SKIP = [/^\/(var\/)?run\/docker\.sock$/, /^\/(proc|sys|dev)(\/|$)/];

/**
 * Volumes and host directories mounted by the stack's containers, from Docker itself: exact
 * volume names and absolute host paths, whatever the compose file wrote.
 */
export async function stackStorage(docker: Docker, serviceId: string): Promise<StorageSource[]> {
  const rows = await docker.listContainers({ all: true, filters: { label: [`${LABEL.service}=${serviceId}`] } });
  const out = new Map<string, StorageSource>();
  for (const row of rows) {
    const name = row.Labels?.["com.docker.compose.service"] ?? row.Names?.[0]?.replace(/^\//, "") ?? row.Id.slice(0, 12);
    for (const m of row.Mounts ?? []) {
      const kind = m.Type === "volume" && m.Name ? "volume" : m.Type === "bind" && m.Source ? "dir" : null;
      if (!kind) continue;
      const source = kind === "volume" ? (m.Name as string) : m.Source;
      if (kind === "dir" && SKIP.some((r) => r.test(source))) continue;
      const key = `${kind}:${source}`;
      const entry = out.get(key) ?? { kind, source, containers: [], destinations: [] };
      if (!entry.containers.includes(name)) entry.containers.push(name);
      if (!entry.destinations.includes(m.Destination)) entry.destinations.push(m.Destination);
      out.set(key, entry);
    }
  }
  return [...out.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.source.localeCompare(b.source));
}

/** Containers of the stack that mount a source, to stop them while it is restored. */
async function containersUsing(docker: Docker, serviceId: string, s: { kind: "volume" | "dir"; source: string }) {
  const rows = await docker.listContainers({ filters: { label: [`${LABEL.service}=${serviceId}`] } });
  return rows.filter((r) => (r.Mounts ?? []).some((m) => (s.kind === "volume" ? m.Type === "volume" && m.Name === s.source : m.Type === "bind" && m.Source === s.source)));
}

const bind = (s: { kind: "volume" | "dir"; source: string }, readOnly: boolean) => `${s.source}:/mnt/data${readOnly ? ":ro" : ""}`;

async function helper(docker: Docker, cmd: string, binds: string[], stdin: boolean) {
  if (!(await imageExists(STORAGE_HELPER_IMAGE, docker))) await pullImage(STORAGE_HELPER_IMAGE, undefined, null, docker);
  return docker.createContainer({
    Image: STORAGE_HELPER_IMAGE,
    Cmd: ["sh", "-c", cmd],
    OpenStdin: stdin,
    StdinOnce: stdin,
    AttachStdin: stdin,
    AttachStdout: true,
    AttachStderr: true,
    Labels: { [LABEL.managed]: "true", [LABEL.kind]: "storage-backup" },
    HostConfig: { Binds: binds, NetworkMode: "none", AutoRemove: false },
  });
}

/** Packs a volume or directory into a .tar.gz on this machine. Returns the size. */
export async function dumpStorage(docker: Docker, s: { kind: "volume" | "dir"; source: string }, file: string) {
  const c = await helper(docker, "cd /mnt && tar czf - data", [bind(s, true)], false);
  try {
    const stream = await c.attach({ stream: true, stdout: true, stderr: true });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let errText = "";
    stderr.on("data", (b: Buffer) => (errText += b.toString()));
    docker.modem.demuxStream(stream, stdout, stderr);
    stream.on("end", () => {
      stdout.end();
      stderr.end();
    });
    await c.start();
    await pipeline(stdout, fs.createWriteStream(file));
    const { StatusCode } = (await c.wait()) as { StatusCode: number };
    if (StatusCode !== 0) throw new Error(errText.trim().slice(-1500) || `tar exited with ${StatusCode}`);
    const { size } = await fs.promises.stat(file);
    if (!size) throw new Error("The backup is empty.");
    return size;
  } finally {
    await c.remove({ force: true }).catch(() => {});
  }
}

/**
 * Replaces the contents of a volume or directory with a .tar.gz made by dumpStorage. The stack's
 * containers that use it are stopped meanwhile and started again after, even when it fails.
 */
export async function restoreStorage(docker: Docker, serviceId: string, s: { kind: "volume" | "dir"; source: string }, file: string, log: (line: string) => void) {
  const users = await containersUsing(docker, serviceId, s);
  for (const u of users) {
    log(`Stopping ${u.Labels?.["com.docker.compose.service"] ?? u.Names[0]}`);
    await docker
      .getContainer(u.Id)
      .stop({ t: 20 })
      .catch(() => {});
  }
  const c = await helper(
    docker,
    // Only a directory can be emptied and refilled; a mounted single file is left alone.
    `[ -d /mnt/data ] || { echo "This mount is a single file; download the backup and copy it by hand." >&2; exit 3; }
cd /mnt && find data -mindepth 1 -delete && tar xzf - data`,
    [bind(s, false)],
    true,
  );
  try {
    const stream = await c.attach({ stream: true, hijack: true, stdin: true, stdout: true, stderr: true });
    let output = "";
    const sink = new PassThrough();
    sink.on("data", (b: Buffer) => (output += b.toString()));
    docker.modem.demuxStream(stream, sink, sink);
    await c.start();
    await pipeline(fs.createReadStream(file), stream, { end: false }).catch(() => {});
    (stream as unknown as { end: () => void }).end();
    const { StatusCode } = (await c.wait()) as { StatusCode: number };
    if (StatusCode !== 0) throw new Error(output.trim().slice(-1500) || `tar exited with ${StatusCode}`);
    return output.trim();
  } finally {
    await c.remove({ force: true }).catch(() => {});
    for (const u of users) {
      log(`Starting ${u.Labels?.["com.docker.compose.service"] ?? u.Names[0]}`);
      await docker
        .getContainer(u.Id)
        .start()
        .catch(() => {});
    }
  }
}
