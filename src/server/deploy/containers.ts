import { existsSync } from "node:fs";
import net from "node:net";
import type Docker from "dockerode";
import { docker, LABEL } from "@/server/docker/client";
import { env } from "@/server/env";
import type { RuntimeConfig, VolumeMount } from "@/server/services/types";
import { fileMountHostPath } from "@/server/services/mounts";
import { statusMatcher, userLabels, validExtraHosts } from "./options";

export function volumeName(slug: string, source: string) {
  return `serve-${slug}-${source}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
}

function splitCommand(command: string): string[] {
  return ["sh", "-c", command];
}

export type ContainerSpec = {
  name: string;
  image: string;
  slug: string;
  serviceId: string;
  deploymentId?: string;
  kind: string;
  env: Record<string, string>;
  runtime: RuntimeConfig;
  aliases: string[];
  /** Docker network the container joins (the environment network). */
  network: string;
  cmd?: string[];
  healthcheck?: string[];
  /** Health check timing in seconds (defaults: every 5s, 5s timeout, 10 retries, 10s start period). */
  healthTiming?: { interval: number; timeout: number; retries: number; startPeriod: number };
  extraBinds?: string[];
  /** The service's directory on the server; file mounts live under it. */
  serviceDir?: string;
};

/** Docker bind strings for a service's mounts. File mounts need the service directory. */
export function mountBinds(slug: string, volumes: VolumeMount[], serviceDir?: string) {
  const binds: string[] = [];
  for (const v of volumes) {
    const ro = v.readOnly ? ":ro" : "";
    if (v.kind === "bind") binds.push(`${v.source}:${v.mountPath}${ro}`);
    else if (v.kind === "file") {
      if (serviceDir) binds.push(`${fileMountHostPath(serviceDir, v.source)}:${v.mountPath}${ro}`);
    } else binds.push(`${volumeName(slug, v.source)}:${v.mountPath}${ro}`);
  }
  return binds;
}

export function createSpec(spec: ContainerSpec): Docker.ContainerCreateOptions {
  const { runtime } = spec;
  const binds = [...mountBinds(spec.slug, runtime.volumes, spec.serviceDir), ...(spec.extraBinds ?? [])];
  const exposed: Record<string, object> = {};
  const bindings: Record<string, { HostPort: string; HostIp?: string }[]> = {};
  if (runtime.port) exposed[`${runtime.port}/tcp`] = {};
  for (const p of runtime.ports) {
    const key = `${p.container}/${p.protocol}`;
    exposed[key] = {};
    const hostIp = p.bindAddress && p.bindAddress !== "0.0.0.0" ? p.bindAddress : undefined;
    bindings[key] = [...(bindings[key] ?? []), hostIp ? { HostIp: hostIp, HostPort: String(p.host) } : { HostPort: String(p.host) }];
  }
  const restart = runtime.restartPolicy;

  return {
    name: spec.name,
    Image: spec.image,
    Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
    Cmd: spec.cmd ?? (runtime.command ? splitCommand(runtime.command) : undefined),
    WorkingDir: runtime.workingDir || undefined,
    User: runtime.user || undefined,
    StopSignal: runtime.stopSignal || undefined,
    StopTimeout: runtime.stopTimeout ?? undefined,
    Labels: {
      ...userLabels(runtime.labels),
      [LABEL.managed]: "true",
      [LABEL.service]: spec.serviceId,
      [LABEL.slug]: spec.slug,
      [LABEL.kind]: spec.kind,
      ...(spec.deploymentId ? { [LABEL.deployment]: spec.deploymentId } : {}),
    },
    ExposedPorts: exposed,
    Healthcheck: spec.healthcheck
      ? {
          Test: spec.healthcheck,
          Interval: (spec.healthTiming?.interval ?? 5) * 1e9,
          Timeout: (spec.healthTiming?.timeout ?? 5) * 1e9,
          Retries: spec.healthTiming?.retries ?? 10,
          StartPeriod: (spec.healthTiming?.startPeriod ?? 10) * 1e9,
        }
      : undefined,
    HostConfig: {
      Binds: binds,
      PortBindings: bindings,
      RestartPolicy: restart === "no" ? { Name: "no" } : restart === "on-failure" ? { Name: "on-failure", MaximumRetryCount: 5 } : { Name: restart },
      NanoCpus: runtime.cpuLimit ? Math.round(runtime.cpuLimit * 1e9) : undefined,
      Memory: runtime.memoryLimit ? runtime.memoryLimit * 1024 * 1024 : undefined,
      MemoryReservation: runtime.memoryReservation ? runtime.memoryReservation * 1024 * 1024 : undefined,
      LogConfig: {
        Type: "json-file",
        Config: { "max-size": `${runtime.logMaxSizeMb ?? 20}m`, "max-file": String(runtime.logMaxFiles ?? 5) },
      },
      ExtraHosts: ["host.docker.internal:host-gateway", ...validExtraHosts(runtime.extraHosts)],
      Init: runtime.init ?? true,
      ShmSize: runtime.shmSize ? runtime.shmSize * 1024 * 1024 : undefined,
      // Only settable by Root organization admins (checked when saving).
      Privileged: runtime.privileged || undefined,
      CapAdd: runtime.capAdd?.length ? runtime.capAdd : undefined,
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [spec.network]: { Aliases: spec.aliases },
      },
    },
  };
}

/** The server a container runs on. Any ServerCtx fits; defaults to the local server. */
export type ContainerTarget = { docker: Docker; proxyContainer: string; local: boolean };

export const localContainerTarget = (): ContainerTarget => ({ docker, proxyContainer: env.proxyContainer, local: true });

export async function startContainer(spec: ContainerSpec, target: ContainerTarget = localContainerTarget()) {
  const container = await target.docker.createContainer(createSpec(spec));
  await container.start();
  return container;
}

async function sleep(ms: number, signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("Deployment cancelled"));
    });
  });
}

function tcpCheck(host: string, port: number, timeout = 2000) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port, timeout });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Workers inside a container cannot route to other bridge networks; probe through the proxy instead. */
const inContainer = existsSync("/.dockerenv");

/** Probe from inside the proxy container, which joins every environment network. Null when the proxy is missing. */
async function proxyProbe(
  target: ContainerTarget,
  host: string,
  port: number,
  pathName: string | null,
  accept: (status: number) => boolean = (s) => s > 0 && s < 500,
): Promise<boolean | null> {
  const { execInContainer } = await import("@/server/docker/client");
  // No shell: the path comes from the service's settings and must never be run as code.
  const cmd = pathName ? ["wget", "-S", "-q", "-T", "4", "-O", "/dev/null", `http://${host}:${port}${pathName}`] : ["nc", "-z", "-w", "2", host, String(port)];
  let res: { exitCode: number; output: string };
  try {
    res = await execInContainer(target.proxyContainer, cmd, {}, target.docker);
  } catch (error) {
    if (/No such container|404|is not running|409/i.test((error as Error).message)) return null;
    return false;
  }
  if (!pathName) return res.exitCode === 0;
  // wget -S prints the response headers: the last status line counts (after redirects).
  const statuses = [...res.output.matchAll(/HTTP\/[\d.]+\s+(\d{3})/g)].map((m) => Number(m[1]));
  return accept(statuses.at(-1) ?? 0);
}

async function httpCheck(url: string, accept: (status: number) => boolean) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: "manual" });
    return accept(res.status);
  } catch {
    return false;
  }
}

async function containerLogsTail(d: Docker, id: string, lines = 30) {
  try {
    const buf = (await d.getContainer(id).logs({ stdout: true, stderr: true, tail: lines })) as unknown as Buffer;
    const { demuxDockerBuffer } = await import("@/server/docker/client");
    return demuxDockerBuffer(buf).trim();
  } catch {
    return "";
  }
}

/**
 * Wait until a container is healthy: it must be running, pass the docker healthcheck
 * (if any), accept connections on its port, and answer the HTTP healthcheck path.
 */
export async function waitHealthy(
  containerId: string,
  runtime: RuntimeConfig,
  log: (line: string) => void,
  signal?: AbortSignal,
  network: string = env.network,
  target: ContainerTarget = localContainerTarget(),
) {
  const d = target.docker;
  let proxyMissingNoted = false;
  const timeoutMs = (runtime.healthcheckTimeout ?? 120) * 1000;
  const started = Date.now();
  let stableSince = 0;
  const probePort = runtime.healthcheckPort || runtime.port;
  const intervalMs = Math.max(1, runtime.healthcheckInterval ?? 1) * 1000;
  const accept = statusMatcher(runtime.healthcheckStatus);
  const needed = Math.max(1, runtime.healthcheckSuccesses ?? 1);
  let successes = 0;
  if (runtime.healthcheckStartPeriod) {
    log(`Waiting ${runtime.healthcheckStartPeriod}s before the first health check`);
    await sleep(runtime.healthcheckStartPeriod * 1000, signal);
  }
  let lastNote = "";
  const note = (msg: string) => {
    if (msg !== lastNote) log(msg);
    lastNote = msg;
  };

  while (Date.now() - started < timeoutMs) {
    const info = await d.getContainer(containerId).inspect();
    const state = info.State;
    if (!state.Running || state.Restarting) {
      if (state.Status === "exited" || state.Restarting || info.RestartCount > 0) {
        const tail = await containerLogsTail(d, containerId);
        throw new Error(`Container exited with code ${state.ExitCode}.${tail ? `\n--- last logs ---\n${tail}` : ""}`);
      }
      await sleep(500, signal);
      continue;
    }
    if (state.Health && state.Health.Status !== "healthy") {
      note(`Waiting for container healthcheck (${state.Health.Status})`);
      await sleep(1000, signal);
      continue;
    }

    const ip = info.NetworkSettings.Networks?.[network]?.IPAddress;
    if (probePort && ip) {
      const probePath = runtime.healthcheckPath ? `${runtime.healthcheckPath.startsWith("/") ? "" : "/"}${runtime.healthcheckPath}` : null;
      // Remote servers (and a containerized worker) cannot reach bridge IPs directly.
      let ok: boolean | null =
        !target.local || inContainer
          ? await proxyProbe(target, ip, probePort, probePath, accept)
          : probePath
            ? await httpCheck(`http://${ip}:${probePort}${probePath}`, accept)
            : await tcpCheck(ip, probePort);
      if (ok === null) {
        // No proxy on that server yet: rely on the container staying up (and its own healthcheck).
        if (!proxyMissingNoted) log("Proxy not running on this server yet, skipping the port check");
        proxyMissingNoted = true;
        ok = true;
      }
      if (!ok) {
        stableSince = 0;
        successes = 0;
        note(
          runtime.healthcheckPath
            ? `Waiting for ${runtime.healthcheckPath} to respond on port ${probePort}${runtime.healthcheckStatus ? ` with ${runtime.healthcheckStatus}` : ""}`
            : `Waiting for the app to listen on port ${probePort}`,
        );
        await sleep(intervalMs, signal);
        continue;
      }
      if (++successes < needed) {
        note(`Health check passed ${successes} of ${needed} times`);
        await sleep(intervalMs, signal);
        continue;
      }
    }

    // Consider healthy after staying up briefly without restarts.
    if (!stableSince) stableSince = Date.now();
    if (Date.now() - stableSince >= (probePort ? 1500 : 5000)) return;
    await sleep(500, signal);
  }
  const tail = await containerLogsTail(d, containerId);
  throw new Error(
    `Healthcheck timed out after ${Math.round(timeoutMs / 1000)}s.${runtime.port ? ` Make sure the app listens on 0.0.0.0:${runtime.port}.` : ""}${tail ? `\n--- last logs ---\n${tail}` : ""}`,
  );
}
