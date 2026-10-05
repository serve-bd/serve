import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import Docker from "dockerode";
import { env } from "@/server/env";
import { freeSharedSubnet } from "./subnets";

const globalForDocker = globalThis as unknown as { docker?: Docker };

export const docker = globalForDocker.docker ?? new Docker({ socketPath: env.dockerSocket });
globalForDocker.docker = docker;

export const LABEL = {
  managed: "serve.managed",
  service: "serve.service",
  deployment: "serve.deployment",
  slug: "serve.slug",
  kind: "serve.kind",
  /** Images built from git: the branch (the standard labels hold the repository and commit). */
  branch: "serve.branch",
  /** Images built from git: a fingerprint of the commit and everything else the build used (see buildKey). */
  buildKey: "serve.build-key",
} as const;

export type LogFn = (line: string) => void;

const networkReady = new WeakMap<Docker, Map<string, Promise<void>>>();

/**
 * Make sure the shared bridge network used by every managed container exists.
 * Pass another server's Docker client and network name to prepare that server.
 */
export function ensureNetwork(d: Docker = docker, name: string = env.network): Promise<void> {
  let perDocker = networkReady.get(d);
  if (!perDocker) networkReady.set(d, (perDocker = new Map()));
  let ready = perDocker.get(name);
  if (!ready) {
    ready = (async () => {
      const networks = await d.listNetworks({ filters: { name: [name] } });
      if (!networks.some((n) => n.Name === name)) {
        const options = {
          Name: name,
          Driver: "bridge",
          Attachable: true,
          Labels: { [LABEL.managed]: "true" },
        };
        try {
          await d.createNetwork(options);
        } catch (error) {
          // Docker's default pools can be exhausted on busy hosts; fall back to a free range of our own.
          if (!/address pools/i.test((error as Error).message)) throw error;
          const used = (await d.listNetworks()).flatMap((n) => (n.IPAM?.Config ?? []).map((c) => c.Subnet ?? "")).filter(Boolean);
          const subnet = freeSharedSubnet(used);
          if (!subnet) throw new Error(`Docker has no free address range for the ${name} network. Remove unused networks with docker network prune.`);
          await d.createNetwork({ ...options, IPAM: { Driver: "default", Config: [{ Subnet: subnet }] } });
        }
      }
    })().catch((error) => {
      perDocker.delete(name);
      throw error;
    });
    perDocker.set(name, ready);
  }
  return ready;
}

export async function imageExists(ref: string, d: Docker = docker): Promise<boolean> {
  try {
    await d.getImage(ref).inspect();
    return true;
  } catch {
    return false;
  }
}

export type RegistryAuth = { username: string; password: string; serveraddress?: string };

/** Pull an image and report compact progress through `log`. `platform` picks one of a multi-platform image. */
/**
 * Copy an image from one Docker to another without a registry: `docker save` streamed into
 * `docker load`, gzipped on the way (Docker unpacks it). Logs progress every few seconds.
 */
/** How long an image copy may move no data before it fails. */
export const COPY_STALL_MS = 120_000;
/** How long the target may take to load a fully sent image. */
const COPY_UNPACK_MS = 15 * 60_000;

export async function copyImage(ref: string, from: Docker, to: Docker, opts: { log?: LogFn; signal?: AbortSignal; stallMs?: number } = {}) {
  const source = (await from.getImage(ref).get()) as NodeJS.ReadableStream & { destroy(error?: Error): void };
  let bytes = 0;
  let logged = Date.now();
  source.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (Date.now() - logged > 5000) {
      logged = Date.now();
      opts.log?.(`Copied ${Math.round(bytes / 1e6)} MB`);
    }
  });
  const gzip = createGzip({ level: 1 });
  const abort = () => source.destroy(new Error("Cancelled"));
  opts.signal?.addEventListener("abort", abort, { once: true });
  // A copy that stops moving (a connection that hangs without closing) fails instead of waiting forever.
  let stalled: Error | null = null;
  let last = Date.now();
  source.on("data", () => {
    last = Date.now();
  });
  // Once every byte is sent, the other server unpacks the image without a word: that may take longer.
  let sent = false;
  source.on("end", () => {
    sent = true;
    last = Date.now();
  });
  let res: NodeJS.ReadableStream | null = null;
  const watchdog = setInterval(() => {
    const limit = sent ? COPY_UNPACK_MS : (opts.stallMs ?? COPY_STALL_MS);
    if (Date.now() - last < limit) return;
    stalled = new Error(
      sent
        ? `The other server took more than ${Math.round(limit / 60_000)} minutes to load the copied image. Check its disk and Docker, then deploy again.`
        : `Copying the image stopped: nothing moved for ${Math.round(limit / 1000)} seconds. Check the connection to both servers and deploy again.`,
    );
    source.destroy(stalled);
    gzip.destroy(stalled);
    (res as unknown as { destroy?: (e: Error) => void } | null)?.destroy?.(stalled);
  }, 1000);
  try {
    const [, loaded] = await Promise.all([pipeline(source, gzip), to.loadImage(gzip, { quiet: true })]);
    res = loaded as NodeJS.ReadableStream;
    // The load's answer counts as progress too: a big image takes a while to unpack there.
    last = Date.now();
    // docker load answers 200 and puts its errors in the body.
    const body = await new Promise<string>((resolve, reject) => {
      let out = "";
      res!.on("data", (c: Buffer) => {
        last = Date.now();
        out += c.toString();
      });
      res!.on("end", () => resolve(out));
      res!.on("error", reject);
      res!.on("close", () => (stalled ? reject(stalled) : resolve(out)));
    });
    const failed = body
      .split("\n")
      .map((line) => {
        try {
          return (JSON.parse(line) as { error?: string }).error;
        } catch {
          return undefined;
        }
      })
      .find(Boolean);
    if (failed) throw new Error(failed);
    opts.log?.(`Copied ${Math.round(bytes / 1e6)} MB`);
  } catch (error) {
    throw stalled ?? error;
  } finally {
    clearInterval(watchdog);
    opts.signal?.removeEventListener("abort", abort);
    // A load that failed early must not leave the save stream open on the source server.
    source.destroy();
  }
}

export async function pullImage(ref: string, log?: LogFn, auth?: RegistryAuth | null, d: Docker = docker, platform?: string | null) {
  const image = ref.includes(":") || ref.includes("@") ? ref : `${ref}:latest`;
  const stream = await d.pull(image, { ...(auth ? { authconfig: auth } : {}), ...(platform ? { platform } : {}) });
  await new Promise<void>((resolve, reject) => {
    const seen = new Set<string>();
    d.modem.followProgress(
      stream,
      (error) => (error ? reject(error) : resolve()),
      (event: { status?: string; id?: string; error?: string }) => {
        if (event.error) {
          log?.(event.error);
          return;
        }
        if (!event.status || !log) return;
        // Skip noisy byte-level progress updates.
        if (event.status === "Downloading" || event.status === "Extracting") return;
        const line = event.id ? `${event.id}: ${event.status}` : event.status;
        if (!seen.has(line)) {
          seen.add(line);
          log(line);
        }
      },
    );
  });
}

/**
 * Whether the server has the image, for `platform` when given (os/architecture[/variant]). With
 * the containerd image store one tag holds several platforms: the inspect asks for this one.
 */
export async function imageExistsFor(ref: string, platform: string | null | undefined, d: Docker = docker): Promise<boolean> {
  if (!platform) return imageExists(ref, d);
  const [os, architecture, variant] = platform.split("/");
  type Info = { Os?: string; Architecture?: string; Variant?: string };
  const info = await new Promise<Info | null>((resolve) =>
    d.modem.dial(
      {
        path: `/images/${ref}/json?`,
        method: "GET",
        options: { platform: JSON.stringify({ os, architecture, ...(variant ? { variant } : {}) }) },
        statusCodes: { 200: true, 404: "no such image", 500: "server error" },
      },
      (error: unknown, data: unknown) => resolve(error ? null : (data as Info)),
    ),
  );
  // Daemons without the platform parameter answer with the image's only platform.
  return !!info && info.Os === os && info.Architecture === architecture && (!variant || info.Variant === variant);
}

export async function listServiceContainers(serviceId: string, all = true, d: Docker = docker) {
  return d.listContainers({
    all,
    filters: { label: [`${LABEL.service}=${serviceId}`] },
  });
}

export async function removeContainer(idOrName: string, timeout = 10, d: Docker = docker) {
  const container = d.getContainer(idOrName);
  try {
    await container.stop({ t: timeout });
  } catch {
    // already stopped or missing
  }
  try {
    await container.remove({ force: true, v: false });
  } catch {
    // missing
  }
}

/** Demultiplex a docker log buffer (8 byte header frames) into text. */
export function demuxDockerBuffer(buffer: Buffer): string {
  let out = "";
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const type = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    if (type > 2 || offset + 8 + size > buffer.length) {
      // Not multiplexed (TTY container).
      return buffer.toString("utf8");
    }
    out += buffer.subarray(offset + 8, offset + 8 + size).toString("utf8");
    offset += 8 + size;
  }
  return out || buffer.toString("utf8");
}

/** Run a command inside a container and collect its output. */
export async function execInContainer(
  idOrName: string,
  cmd: string[],
  opts: { env?: string[]; user?: string } = {},
  d: Docker = docker,
): Promise<{ exitCode: number; output: string }> {
  const container = d.getContainer(idOrName);
  const exec = await container.exec({
    Cmd: cmd,
    Env: opts.env,
    User: opts.user,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", reject);
  });
  // The command finished: release the connection right away.
  (stream as { destroy?: () => void }).destroy?.();
  return { exitCode: (await execExitCode(exec)) ?? 0, output: demuxDockerBuffer(Buffer.concat(chunks)) };
}

/**
 * Exit code of an exec whose output ended. Docker may still report it running (exit code null)
 * for a moment after the stream closes, so it asks again for up to `waitMs` (3 seconds).
 */
export async function execExitCode(exec: Docker.Exec, waitMs = 3000): Promise<number | null> {
  for (let i = 0; ; i++) {
    const info = await exec.inspect();
    if (!info.Running || i >= waitMs / 100) return info.ExitCode ?? null;
    await new Promise((r) => setTimeout(r, 100));
  }
}
