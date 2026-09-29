import Docker from "dockerode";
import { env } from "@/server/env";

const globalForDocker = globalThis as unknown as { docker?: Docker };

export const docker = globalForDocker.docker ?? new Docker({ socketPath: env.dockerSocket });
globalForDocker.docker = docker;

export const LABEL = {
  managed: "serve.managed",
  service: "serve.service",
  deployment: "serve.deployment",
  slug: "serve.slug",
  kind: "serve.kind",
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
          // Docker's default pools can be exhausted on busy hosts; fall back to a fixed range.
          if (!/address pools/i.test((error as Error).message)) throw error;
          await d.createNetwork({ ...options, IPAM: { Driver: "default", Config: [{ Subnet: "10.209.0.0/16" }] } });
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

/** Pull an image and report compact progress through `log`. */
export async function pullImage(ref: string, log?: LogFn, auth?: RegistryAuth | null, d: Docker = docker) {
  const image = ref.includes(":") || ref.includes("@") ? ref : `${ref}:latest`;
  const stream = await d.pull(image, auth ? { authconfig: auth } : {});
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
  const info = await exec.inspect();
  return { exitCode: info.ExitCode ?? 0, output: demuxDockerBuffer(Buffer.concat(chunks)) };
}
