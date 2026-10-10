import { PassThrough, type Readable } from "node:stream";
import type Docker from "dockerode";
import { imageExists, LABEL, pullImage } from "@/server/docker/client";
import { execChannel, type SshTarget, sh } from "@/server/servers/ssh";
import { FILES_SCRIPT } from "./script";

/*
 * The file manager works through a small helper container on the server, the same way for the
 * dashboard's own machine and for servers reached over SSH:
 *   - a server's files: the host's "/" mounted at /host;
 *   - a container's files: a helper sharing the container's process namespace, which reads them
 *     at /proc/1/root (the container's own view, its volumes included, whatever the storage
 *     driver). It sees nothing of the host, and goes away with the container.
 * A helper stops by itself after 10 minutes without use, so a restart of Serve leaves none behind.
 *
 * On a server reached over SSH, each operation is one `docker exec` over one SSH channel: through
 * the Docker API it would take several round trips, and uploads would crawl.
 */

const IMAGE = "alpine:3.22.6";
const IDLE_SECONDS = 600;

/** Where the files are. `ssh`: the server is remote (operations run over SSH). */
export type FilesPlace = { docker: Docker; ssh: SshTarget | null } & ({ kind: "host" } | { kind: "container"; containerId: string });

export const rootOf = (place: FilesPlace) => (place.kind === "host" ? "/host" : "/proc/1/root");

const helperName = (place: FilesPlace) => (place.kind === "host" ? "serve-files-host" : `serve-files-${place.containerId.slice(0, 12)}`);

/** Each operation marks the helper as in use (see KEEPALIVE), then runs the script. */
const OP_SCRIPT = `touch /tmp/alive 2>/dev/null\n${FILES_SCRIPT}`;

const KEEPALIVE = `touch /tmp/alive; while sleep 20; do [ $(( $(date +%s) - $(stat -c %Y /tmp/alive) )) -lt ${IDLE_SECONDS} ] || exit 0; done`;

const starting = new Map<string, Promise<string>>();

async function startHelper(place: FilesPlace): Promise<string> {
  const name = helperName(place);
  const existing = await place.docker
    .getContainer(name)
    .inspect()
    .catch(() => null);
  if (existing?.State.Running) return existing.Id;
  if (existing)
    await place.docker
      .getContainer(name)
      .remove({ force: true })
      .catch(() => {});
  if (!(await imageExists(IMAGE, place.docker))) await pullImage(IMAGE, undefined, null, place.docker);
  try {
    const container = await place.docker.createContainer({
      name,
      Image: IMAGE,
      Cmd: ["sh", "-c", KEEPALIVE],
      Labels: { [LABEL.managed]: "true", [LABEL.kind]: "files" },
      HostConfig:
        place.kind === "host"
          ? { Binds: ["/:/host:rslave"], NetworkMode: "none", AutoRemove: true, RestartPolicy: { Name: "no" } }
          : { PidMode: `container:${place.containerId}`, NetworkMode: "none", AutoRemove: true, RestartPolicy: { Name: "no" } },
    });
    await container.start();
    return container.id;
  } catch (e) {
    // Another request started it first.
    if ((e as { statusCode?: number }).statusCode === 409) {
      const info = await place.docker.getContainer(name).inspect();
      if (info.State.Running) return info.Id;
    }
    throw e;
  }
}

/** Helpers seen running lately, by key: each check costs round trips to a remote server. */
const seen = new Map<string, number>();
const SEEN_MS = 5 * 60_000;

const keyOf = (place: FilesPlace) => `${helperName(place)}@${place.ssh?.id ?? "local"}`;

/** The running helper for this place, started when needed (concurrent callers share one start). */
async function helper(place: FilesPlace, recheck = false): Promise<void> {
  const key = keyOf(place);
  if (!recheck && Date.now() - (seen.get(key) ?? 0) < SEEN_MS) return;
  let p = starting.get(key);
  if (!p) {
    p = startHelper(place).finally(() => starting.delete(key));
    starting.set(key, p);
  }
  await p;
  seen.set(key, Date.now());
}

/** The helper is gone (idle, or its container restarted): check it again next time. */
const forget = (place: FilesPlace) => seen.delete(keyOf(place));

export class FilesError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

/** HTTP status for an exit code of the script: 409 exists already, 412 changed since read, 503 no running container. */
export function filesStatus(code: number) {
  return { 2: 404, 3: 403, 5: 400, 6: 409, 7: 412, 9: 503 }[code] ?? 500;
}

type Run = { stdout: Readable; done: Promise<void> };

/**
 * Runs one operation. `stdout` streams the output; `done` settles when it ends, and rejects with
 * the script's message when it fails. `stdin` is piped in and closed at its end.
 */
export async function runOp(place: FilesPlace, args: string[], stdin?: Readable | null, signal?: AbortSignal): Promise<Run> {
  if (place.ssh) return runOverSsh(place, place.ssh, args, stdin, signal);
  // Uploads check the helper first: their input cannot be sent twice.
  await helper(place, !!stdin);
  const create = () =>
    place.docker
      .getContainer(helperName(place))
      .exec({ Cmd: ["sh", "-c", OP_SCRIPT, "files", rootOf(place), ...args], AttachStdout: true, AttachStderr: true, AttachStdin: !!stdin });
  let exec: Docker.Exec;
  try {
    exec = await create();
  } catch (e) {
    // The helper stopped (idle, or its container restarted) since it was last seen.
    if ((e as { statusCode?: number }).statusCode !== 409 && (e as { statusCode?: number }).statusCode !== 404) throw e;
    await helper(place, true);
    exec = await create();
  }
  const stream = (await exec.start({ hijack: true, stdin: !!stdin })) as unknown as NodeJS.ReadWriteStream & { destroy: () => void };
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let errText = "";
  stderr.on("data", (b: Buffer) => {
    if (errText.length < 4000) errText += b.toString();
  });
  place.docker.modem.demuxStream(stream, stdout, stderr);
  const onAbort = () => stream.destroy();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (stdin) {
    stdin.on("error", () => stream.destroy());
    stdin.pipe(stream as unknown as NodeJS.WritableStream, { end: true });
  }
  const done = new Promise<void>((resolve, reject) => {
    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      stderr.end();
      if (signal?.aborted) {
        stdout.destroy(new FilesError(1, "Cancelled"));
        return reject(new FilesError(1, "Cancelled"));
      }
      // The stream can end a moment before Docker records the exit code.
      let info = await exec.inspect().catch(() => null);
      for (let i = 0; i < 20 && info?.Running; i++) {
        await new Promise((r) => setTimeout(r, 50));
        info = await exec.inspect().catch(() => null);
      }
      const code = info?.ExitCode ?? 1;
      if (code === 0) {
        stdout.end();
        return resolve();
      }
      const err = new FilesError(code, errText.trim().split("\n").pop() || "The operation failed");
      stdout.destroy(err);
      reject(err);
    };
    stream.on("end", () => void finish());
    stream.on("close", () => void finish());
    stream.on("error", (e: Error) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      stdout.destroy(e);
      reject(e);
    });
  });
  // Callers that only stream must not crash on an unhandled rejection.
  done.catch(() => {});
  return { stdout, done };
}

async function runOverSsh(place: FilesPlace, ssh: SshTarget, args: string[], stdin?: Readable | null, signal?: AbortSignal, retried = false): Promise<Run> {
  // Uploads check the helper first: their input cannot be sent twice.
  await helper(place, !!stdin || retried);
  const command = ["docker", "exec", ...(stdin ? ["-i"] : []), helperName(place), "sh", "-c", OP_SCRIPT, "files", rootOf(place), ...args]
    .map((w, i) => (i < 2 ? w : sh(w)))
    .join(" ");
  const ch = await execChannel(ssh, command);
  let errText = "";
  ch.stderr.on("data", (b: Buffer) => {
    if (errText.length < 4000) errText += b.toString();
  });
  const closed = new Promise<number>((resolve) => ch.once("close", () => resolve(ch.exitStatus() ?? 1)));
  // Without input, the first output (or the end) tells whether docker exec found the helper.
  if (!stdin) {
    ch.end();
    if (!retried) {
      const first = await Promise.race([new Promise<"data">((resolve) => ch.once("readable", () => resolve("data"))), closed]);
      if (first !== "data" && first !== 0 && /No such container|is not running/i.test(errText)) {
        forget(place);
        return runOverSsh(place, ssh, args, stdin, signal, true);
      }
    }
  }
  const stdout = new PassThrough();
  ch.pipe(stdout, { end: false });
  const onAbort = () => ch.close();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (stdin) {
    stdin.on("error", () => ch.close());
    stdin.pipe(ch, { end: true });
  }
  const done = closed.then((code) => {
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) throw new FilesError(1, "Cancelled");
    if (code !== 0) throw new FilesError(code, errText.trim().split("\n").pop() || "The operation failed");
  });
  done.then(
    () => stdout.end(),
    (e: Error) => stdout.destroy(e),
  );
  // Callers that only stream must not crash on an unhandled rejection.
  done.catch(() => {});
  return { stdout, done };
}

/** Runs an operation to its end and returns its output. */
export async function runOpBuffer(place: FilesPlace, args: string[], stdin?: Readable | null, max = 8 * 1024 * 1024): Promise<Buffer> {
  const { stdout, done } = await runOp(place, args, stdin);
  const chunks: Buffer[] = [];
  let size = 0;
  stdout.on("data", (b: Buffer) => {
    size += b.length;
    if (size <= max) chunks.push(b);
  });
  stdout.on("error", () => {});
  await done;
  if (size > max) throw new FilesError(5, "The answer is too large");
  return Buffer.concat(chunks);
}
