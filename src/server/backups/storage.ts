import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import type Docker from "dockerode";
import { imageExists, LABEL, pullImage } from "@/server/docker/client";
import { env } from "@/server/env";

/** Small image that packs and unpacks storage; pinned like every image Serve runs itself. */
export const STORAGE_HELPER_IMAGE = "alpine:3.22.6";

/** A volume or a host directory that containers of a stack mount. */
export type StorageSource = { kind: "volume" | "dir"; source: string; containers: string[]; destinations: string[] };

/**
 * Paths never offered for a storage backup: Docker's socket, the host's system folders and Serve's
 * own data. Restoring one of them would replace the whole folder on the host.
 */
const SKIP = [/^\/(var\/)?run\/docker\.sock$/, /^\/$/, /^\/(proc|sys|dev|boot|etc|root|usr|bin|sbin|lib|lib64|var\/lib\/docker|run)(\/|$)/];

/** Where a server keeps Serve's data, and the folder of one service in it. */
export type StoragePaths = { root: string; service: (serviceId: string) => string };

/**
 * Whether a host path is off limits: a system folder or Serve's own data directory on that server.
 * Inside the service's own folder only folders below the compose project's directory are allowed
 * (a compose file's `./data`): the directory itself holds the stack's `.env` with its secrets.
 */
export function blockedPath(raw: string, paths?: StoragePaths, serviceId?: string, projectDirs: string[] = []) {
  const p = path.posix.normalize(raw).replace(/(.)\/+$/, "$1");
  if (SKIP.some((r) => r.test(p))) return true;
  if (paths && serviceId && p.startsWith(`${paths.service(serviceId).replace(/\/+$/, "")}/`)) {
    return !projectDirs.some((d) => p.startsWith(`${path.posix.normalize(d).replace(/\/+$/, "")}/`));
  }
  const roots = [env.dataDir, "/data/serve", ...(paths ? [paths.root] : [])].map((r) => r.replace(/\/+$/, ""));
  return roots.some((data) => p === data || p.startsWith(`${data}/`));
}

/**
 * Volumes and host directories mounted by the stack's containers, from Docker itself: exact
 * volume names and absolute host paths, whatever the compose file wrote.
 */
export async function stackStorage(
  server: { docker: Docker; paths: StoragePaths; exec?: (command: string) => Promise<{ code: number | null; stdout: string }> },
  serviceId: string,
): Promise<StorageSource[]> {
  const { docker } = server;
  const rows = await docker.listContainers({ all: true, filters: { label: [`${LABEL.service}=${serviceId}`] } });
  const out = new Map<string, StorageSource>();
  const projectDirs = rows.map((r) => r.Labels?.["com.docker.compose.project.working_dir"]).filter((d): d is string => !!d);
  const dirs = [...new Set(rows.flatMap((r) => (r.Mounts ?? []).filter((m) => m.Type === "bind" && m.Source).map((m) => m.Source)))];
  const real = await realPaths(server, dirs);
  for (const row of rows) {
    const name = row.Labels?.["com.docker.compose.service"] ?? row.Names?.[0]?.replace(/^\//, "") ?? row.Id.slice(0, 12);
    for (const m of row.Mounts ?? []) {
      const kind = m.Type === "volume" && m.Name ? "volume" : m.Type === "bind" && m.Source ? "dir" : null;
      if (!kind) continue;
      const source = kind === "volume" ? (m.Name as string) : m.Source;
      // A folder reached through a symbolic link is judged by where it really is, too.
      if (kind === "dir" && (blockedPath(source, server.paths, serviceId, projectDirs) || blockedPath(real.get(source) ?? source, server.paths, serviceId, projectDirs))) continue;
      const key = `${kind}:${source}`;
      const entry = out.get(key) ?? { kind, source, containers: [], destinations: [] };
      if (!entry.containers.includes(name)) entry.containers.push(name);
      if (!entry.destinations.includes(m.Destination)) entry.destinations.push(m.Destination);
      out.set(key, entry);
    }
  }
  return [...out.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.source.localeCompare(b.source));
}

/** Where each host folder really is, following symbolic links, read on the server. Unknown ones are left out. */
async function realPaths(server: { exec?: (command: string) => Promise<{ code: number | null; stdout: string }> }, dirs: string[]) {
  const out = new Map<string, string>();
  if (!server.exec || !dirs.length) return out;
  const quote = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;
  const res = await server.exec(`for p in ${dirs.map(quote).join(" ")}; do realpath -e -- "$p" 2>/dev/null || echo; done`).catch(() => null);
  const lines = res?.stdout.split("\n") ?? [];
  dirs.forEach((d, i) => {
    const r = lines[i]?.trim();
    if (r?.startsWith("/")) out.set(d, r);
  });
  return out;
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

/** Runs a helper to the end, feeding `input` on stdin when given. Throws with its output on failure. */
async function runHelper(docker: Docker, cmd: string, binds: string[], input?: string) {
  const c = await helper(docker, cmd, binds, !!input);
  try {
    const stream = await c.attach({ stream: true, hijack: !!input, stdin: !!input, stdout: true, stderr: true });
    let output = "";
    const sink = new PassThrough();
    sink.on("data", (b: Buffer) => (output += b.toString()));
    docker.modem.demuxStream(stream, sink, sink);
    await c.start();
    if (input) {
      await pipeline(fs.createReadStream(input), stream, { end: false }).catch(() => {});
      (stream as unknown as { end: () => void }).end();
    }
    const { StatusCode } = (await c.wait()) as { StatusCode: number };
    if (StatusCode !== 0) throw new Error(output.trim().slice(-1500) || `The helper exited with ${StatusCode}`);
    return output.trim();
  } finally {
    await c.remove({ force: true }).catch(() => {});
  }
}

const STAGING = ".serve-restore";

/**
 * Replaces the contents of a volume or directory with a .tar.gz made by dumpStorage.
 *   1. Unpack into a staging folder inside it while the app keeps running. A damaged or cut-off
 *      archive fails here and nothing is touched.
 *   2. Stop the stack's containers that use it, swap the staged files in, start them again (even
 *      when the swap fails).
 */
export async function restoreStorage(
  docker: Docker,
  serviceId: string,
  s: { kind: "volume" | "dir"; source: string },
  file: string,
  log: (line: string) => void,
  onStopped?: (ids: string[]) => Promise<void>,
) {
  if (!(await imageExists(STORAGE_HELPER_IMAGE, docker))) await pullImage(STORAGE_HELPER_IMAGE, undefined, null, docker);
  log("Unpacking the backup");
  await runHelper(
    docker,
    // Only a directory can be refilled; a mounted single file is left alone.
    `[ -d /mnt/data ] || { echo "This mount is a single file; download the backup and copy it by hand." >&2; exit 3; }
cd /mnt/data && rm -rf ${STAGING} && mkdir ${STAGING} || exit 1
if ! tar xzf - -C ${STAGING} || [ ! -d ${STAGING}/data ]; then rm -rf ${STAGING}; echo "The backup is damaged or incomplete. Nothing was changed." >&2; exit 4; fi`,
    [bind(s, false)],
    file,
  );
  const users = await containersUsing(docker, serviceId, s);
  // Recorded before they stop: if the worker dies now, it starts exactly these again.
  await onStopped?.(users.map((u) => u.Id));
  for (const u of users) {
    log(`Stopping ${u.Labels?.["com.docker.compose.service"] ?? u.Names[0]}`);
    await docker
      .getContainer(u.Id)
      .stop({ t: 20 })
      .catch(() => {});
  }
  try {
    log("Replacing the files");
    return await runHelper(
      docker,
      `cd /mnt/data && find . -mindepth 1 -maxdepth 1 ! -name ${STAGING} -exec rm -rf {} + && find ${STAGING}/data -mindepth 1 -maxdepth 1 -exec mv {} . \\; && rm -rf ${STAGING}`,
      [bind(s, false)],
    );
  } finally {
    for (const u of users) {
      log(`Starting ${u.Labels?.["com.docker.compose.service"] ?? u.Names[0]}`);
      await docker
        .getContainer(u.Id)
        .start()
        .catch(() => {});
    }
    await onStopped?.([]).catch(() => {});
  }
}

/**
 * After a restore was cut off (the worker restarted): starts the containers it had stopped, when
 * they are still stopped. Containers someone else stopped stay as they are.
 */
export async function startStoppedContainers(docker: Docker, ids: string[]) {
  for (const id of ids) {
    const info = await docker
      .getContainer(id)
      .inspect()
      .catch(() => null);
    if (!info || info.State.Running) continue;
    await docker
      .getContainer(id)
      .start()
      .catch(() => {});
  }
}
