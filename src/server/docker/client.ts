import Docker from "dockerode";
import { env } from "@/server/env";

const globalForDocker = globalThis as unknown as { docker?: Docker };

export const docker =
  globalForDocker.docker ?? new Docker({ socketPath: env.dockerSocket });
globalForDocker.docker = docker;

export const LABEL = {
  managed: "serve.managed",
  service: "serve.service",
  deployment: "serve.deployment",
  slug: "serve.slug",
  kind: "serve.kind",
} as const;

export type LogFn = (line: string) => void;

let networkReady: Promise<void> | null = null;

/** Make sure the shared bridge network used by every managed container exists. */
export function ensureNetwork(): Promise<void> {
  if (!networkReady) {
    networkReady = (async () => {
      const networks = await docker.listNetworks({ filters: { name: [env.network] } });
      if (!networks.some((n) => n.Name === env.network)) {
        await docker.createNetwork({
          Name: env.network,
          Driver: "bridge",
          Attachable: true,
          Labels: { [LABEL.managed]: "true" },
        });
      }
    })().catch((error) => {
      networkReady = null;
      throw error;
    });
  }
  return networkReady;
}

export async function imageExists(ref: string): Promise<boolean> {
  try {
    await docker.getImage(ref).inspect();
    return true;
  } catch {
    return false;
  }
}

export type RegistryAuth = { username: string; password: string; serveraddress?: string };

/** Pull an image and report compact progress through `log`. */
export async function pullImage(ref: string, log?: LogFn, auth?: RegistryAuth | null) {
  const image = ref.includes(":") || ref.includes("@") ? ref : `${ref}:latest`;
  const stream = await docker.pull(image, auth ? { authconfig: auth } : {});
  await new Promise<void>((resolve, reject) => {
    const seen = new Set<string>();
    docker.modem.followProgress(
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

export async function listServiceContainers(serviceId: string, all = true) {
  return docker.listContainers({
    all,
    filters: { label: [`${LABEL.service}=${serviceId}`] },
  });
}

export async function removeContainer(idOrName: string, timeout = 10) {
  const container = docker.getContainer(idOrName);
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
): Promise<{ exitCode: number; output: string }> {
  const container = docker.getContainer(idOrName);
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
    stream.on("error", reject);
  });
  const info = await exec.inspect();
  return { exitCode: info.ExitCode ?? 0, output: demuxDockerBuffer(Buffer.concat(chunks)) };
}
