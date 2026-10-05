import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import type Docker from "dockerode";
import { docker as localDocker, LABEL, listServiceContainers } from "@/server/docker/client";
import { getServer, serverOf } from "@/server/servers/context";
import { runServerIds } from "@/server/deploy/distribution";

type Service = typeof schema.service.$inferSelect;

/**
 * Running containers a command can be executed in, with a readable label. An app on several
 * servers has its replicas on the extra servers too: their names repeat per server, so they are
 * picked as "<server id>:<name>" and labeled with the server.
 */
export async function execTargets(service: Service) {
  const current = (c: { Labels: Record<string, string> }) =>
    service.type === "app" && service.currentDeploymentId ? c.Labels[LABEL.deployment] === service.currentDeploymentId : true;
  const server = await serverOf(service);
  const own = (await listServiceContainers(service.id, false, server.docker)).filter(current).map((c) => {
    const name = c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12);
    const composeService = c.Labels["com.docker.compose.service"] ?? null;
    return { id: c.Id, name, composeService, key: composeService ?? name, server: null as { id: string; name: string } | null, docker: server.docker };
  });
  const extras = service.type === "app" ? runServerIds(service.serverId, service.distribution).slice(1) : [];
  const remote = await Promise.all(
    extras.map(async (id) => {
      try {
        const ctx = await getServer(id);
        return (await listServiceContainers(service.id, false, ctx.docker))
          .filter((c) => current(c) && c.Labels[LABEL.kind] !== "predeploy")
          .map((c) => {
            const name = c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12);
            return { id: c.Id, name, composeService: null, key: `${id}:${name}`, server: { id, name: ctx.name }, docker: ctx.docker };
          });
      } catch {
        // An extra server that cannot be reached offers no containers.
        return [];
      }
    }),
  );
  return [...own, ...remote.flat()];
}

export async function pickContainer(service: Service, target?: string | null) {
  const targets = await execTargets(service);
  if (!targets.length) throw new Error("No running container. Deploy or start the service first.");
  if (!target) return targets[0];
  const match = targets.find((t) => t.key === target) ?? targets.find((t) => !t.server && (t.composeService === target || t.name === target || t.id.startsWith(target)));
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
  // Marks the command's processes (children inherit it), so a timeout can find and stop them.
  const marker = `SERVE_EXEC=${randomBytes(8).toString("hex")}`;
  const exec = await container.exec({
    Cmd: ["sh", "-c", command],
    AttachStdout: true,
    AttachStderr: true,
    Env: ["TERM=dumb", marker],
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
    const timer = setTimeout(
      () => {
        timedOut = true;
        (stream as unknown as { destroy: () => void }).destroy();
        finish();
      },
      (opts.timeoutSeconds ?? 600) * 1000,
    );
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", finish);
    opts.signal?.addEventListener("abort", () => {
      (stream as unknown as { destroy: () => void }).destroy();
      finish();
    });
  });
  // Docker can report the exec as still running for a moment after its output ended; its exit
  // code comes only after that. A stream cut off (a dropped connection) leaves it unknown, which is
  // not a success.
  let info = await exec.inspect().catch(() => null);
  for (let i = 0; i < 20 && !timedOut && !opts.signal?.aborted && info?.Running; i++) {
    await new Promise((r) => setTimeout(r, 100));
    info = await exec.inspect().catch(() => null);
  }
  // Dropping the stream does not stop the command: Docker has no call to kill an exec, so it would
  // keep running (and holding locks or load) in the container.
  if (timedOut) await killMarked(container, marker);
  return {
    exitCode: timedOut ? 124 : (info?.ExitCode ?? (opts.signal?.aborted ? 130 : 1)),
    output: output.length >= max ? `${output}\n… output truncated` : output,
    timedOut,
  };
}

/**
 * The shell script that kills every process whose environment holds `marker`, by reading
 * /proc in the container. The killer's own environment does not hold it, so it never kills itself.
 */
export function killMarkedScript(marker: string) {
  if (!/^SERVE_EXEC=[0-9a-f]+$/.test(marker)) throw new Error("Invalid exec marker");
  return `for p in /proc/[0-9]*; do grep -qs '${marker}' "$p/environ" && kill -9 "\${p#/proc/}" 2>/dev/null; done; exit 0`;
}

/** Best effort and bounded: a container without a shell or grep, or one that stopped, keeps what it has. */
export async function killMarked(container: Docker.Container, marker: string) {
  try {
    const killer = await container.exec({ Cmd: ["sh", "-c", killMarkedScript(marker)], AttachStdout: true, AttachStderr: true });
    const stream = await killer.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        (stream as unknown as { destroy: () => void }).destroy();
        done();
      }, 10_000);
      stream.on("end", done);
      stream.on("close", done);
      stream.on("error", done);
      stream.resume();
    });
  } catch {
    // The container went away or cannot run the script: nothing more to stop.
  }
}

export async function getService(serviceId: string) {
  const [service] = await db.select().from(schema.service).where(eq(schema.service.id, serviceId));
  return service ?? null;
}
