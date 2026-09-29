import { PassThrough } from "node:stream";
import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import type Docker from "dockerode";
import { docker as localDocker, LABEL, listServiceContainers } from "@/server/docker/client";
import { serverOf } from "@/server/servers/context";

type Service = typeof schema.service.$inferSelect;

/** Running containers a command can be executed in, with a readable label. */
export async function execTargets(service: Service) {
  const server = await serverOf(service);
  const containers = (await listServiceContainers(service.id, false, server.docker)).filter((c) =>
    service.type === "app" && service.currentDeploymentId ? c.Labels[LABEL.deployment] === service.currentDeploymentId : true,
  );
  return containers.map((c) => ({
    id: c.Id,
    name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
    composeService: c.Labels["com.docker.compose.service"] ?? null,
    /** Docker client of the server the container runs on. */
    docker: server.docker,
  }));
}

export async function pickContainer(service: Service, target?: string | null) {
  const targets = await execTargets(service);
  if (!targets.length) throw new Error("No running container. Deploy or start the service first.");
  if (!target) return targets[0];
  const match = targets.find((t) => t.composeService === target || t.name === target || t.id.startsWith(target));
  if (!match) throw new Error(`No running container matches "${target}".`);
  return match;
}

export type ExecResult = { exitCode: number; output: string; timedOut: boolean };

/** Run `sh -c command` in a container, streaming output chunks. */
export async function execCommand(
  containerId: string,
  command: string,
  opts: { onData?: (text: string) => void; signal?: AbortSignal; timeoutSeconds?: number; maxOutput?: number; docker?: Docker } = {},
): Promise<ExecResult> {
  const docker = opts.docker ?? localDocker;
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    Cmd: ["sh", "-c", command],
    AttachStdout: true,
    AttachStderr: true,
    Env: ["TERM=dumb"],
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const max = opts.maxOutput ?? 256_000;
  let output = "";
  const sink = new PassThrough();
  sink.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (output.length < max) output += text;
    opts.onData?.(text);
  });
  docker.modem.demuxStream(stream, sink, sink);

  let timedOut = false;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      (stream as unknown as { destroy: () => void }).destroy();
      finish();
    }, (opts.timeoutSeconds ?? 600) * 1000);
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", finish);
    opts.signal?.addEventListener("abort", () => {
      (stream as unknown as { destroy: () => void }).destroy();
      finish();
    });
  });
  const info = await exec.inspect().catch(() => null);
  return {
    exitCode: timedOut ? 124 : (info?.ExitCode ?? (opts.signal?.aborted ? 130 : 0)),
    output: output.length >= max ? `${output}\n… output truncated` : output,
    timedOut,
  };
}

export async function getService(serviceId: string) {
  const [service] = await db.select().from(schema.service).where(eq(schema.service.id, serviceId));
  return service ?? null;
}
