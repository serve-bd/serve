import { existsSync } from "node:fs";
import net from "node:net";
import type Docker from "dockerode";
import { docker, LABEL } from "@/server/docker/client";
import { env } from "@/server/env";
import type { RuntimeConfig } from "@/server/services/types";

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
  extraBinds?: string[];
};

export function createSpec(spec: ContainerSpec): Docker.ContainerCreateOptions {
  const { runtime } = spec;
  const binds = [
    ...runtime.volumes.map((v) =>
      v.kind === "bind" ? `${v.source}:${v.mountPath}` : `${volumeName(spec.slug, v.source)}:${v.mountPath}`,
    ),
    ...(spec.extraBinds ?? []),
  ];
  const exposed: Record<string, object> = {};
  const bindings: Record<string, { HostPort: string }[]> = {};
  if (runtime.port) exposed[`${runtime.port}/tcp`] = {};
  for (const p of runtime.ports) {
    const key = `${p.container}/${p.protocol}`;
    exposed[key] = {};
    bindings[key] = [...(bindings[key] ?? []), { HostPort: String(p.host) }];
  }
  const restart = runtime.restartPolicy;

  return {
    name: spec.name,
    Image: spec.image,
    Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
    Cmd: spec.cmd ?? (runtime.command ? splitCommand(runtime.command) : undefined),
    Labels: {
      [LABEL.managed]: "true",
      [LABEL.service]: spec.serviceId,
      [LABEL.slug]: spec.slug,
      [LABEL.kind]: spec.kind,
      ...(spec.deploymentId ? { [LABEL.deployment]: spec.deploymentId } : {}),
    },
    ExposedPorts: exposed,
    Healthcheck: spec.healthcheck
      ? { Test: spec.healthcheck, Interval: 5e9, Timeout: 5e9, Retries: 10, StartPeriod: 10e9 }
      : undefined,
    HostConfig: {
      Binds: binds,
      PortBindings: bindings,
      RestartPolicy:
        restart === "no" ? { Name: "no" } : restart === "on-failure" ? { Name: "on-failure", MaximumRetryCount: 5 } : { Name: restart },
      NanoCpus: runtime.cpuLimit ? Math.round(runtime.cpuLimit * 1e9) : undefined,
      Memory: runtime.memoryLimit ? runtime.memoryLimit * 1024 * 1024 : undefined,
      LogConfig: { Type: "json-file", Config: { "max-size": "20m", "max-file": "5" } },
      ExtraHosts: ["host.docker.internal:host-gateway"],
      Init: true,
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [spec.network]: { Aliases: spec.aliases },
      },
    },
  };
}

export async function startContainer(spec: ContainerSpec) {
  const container = await docker.createContainer(createSpec(spec));
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

async function proxyProbe(host: string, port: number, pathName: string | null) {
  const { execInContainer } = await import("@/server/docker/client");
  const cmd = pathName
    ? `wget -S -q -T 4 -O /dev/null "http://${host}:${port}${pathName}" 2>&1 | awk '/HTTP\//{print $2}' | tail -1`
    : `nc -z -w 2 ${host} ${port} && echo open`;
  const res = await execInContainer(env.proxyContainer, ["sh", "-c", cmd]).catch(() => ({ exitCode: 1, output: "" }));
  const out = res.output.trim();
  if (!pathName) return out.includes("open");
  const status = Number(out.split(/\s+/).pop());
  return status > 0 && status < 500;
}

async function httpCheck(url: string) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: "manual" });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function containerLogsTail(id: string, lines = 30) {
  try {
    const buf = (await docker.getContainer(id).logs({ stdout: true, stderr: true, tail: lines })) as unknown as Buffer;
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
) {
  const timeoutMs = (runtime.healthcheckTimeout ?? 120) * 1000;
  const started = Date.now();
  let stableSince = 0;
  let lastNote = "";
  const note = (msg: string) => {
    if (msg !== lastNote) log(msg);
    lastNote = msg;
  };

  while (Date.now() - started < timeoutMs) {
    const info = await docker.getContainer(containerId).inspect();
    const state = info.State;
    if (!state.Running || state.Restarting) {
      if (state.Status === "exited" || state.Restarting || info.RestartCount > 0) {
        const tail = await containerLogsTail(containerId);
        throw new Error(
          `Container exited with code ${state.ExitCode}.${tail ? `\n--- last logs ---\n${tail}` : ""}`,
        );
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
    if (runtime.port && ip) {
      const probePath = runtime.healthcheckPath ? `${runtime.healthcheckPath.startsWith("/") ? "" : "/"}${runtime.healthcheckPath}` : null;
      const ok = inContainer
        ? await proxyProbe(ip, runtime.port, probePath)
        : probePath
          ? await httpCheck(`http://${ip}:${runtime.port}${probePath}`)
          : await tcpCheck(ip, runtime.port);
      if (!ok) {
        stableSince = 0;
        note(
          runtime.healthcheckPath
            ? `Waiting for ${runtime.healthcheckPath} to respond on port ${runtime.port}`
            : `Waiting for the app to listen on port ${runtime.port}`,
        );
        await sleep(1000, signal);
        continue;
      }
    }

    // Consider healthy after staying up briefly without restarts.
    if (!stableSince) stableSince = Date.now();
    if (Date.now() - stableSince >= (runtime.port ? 1500 : 5000)) return;
    await sleep(500, signal);
  }
  const tail = await containerLogsTail(containerId);
  throw new Error(
    `Healthcheck timed out after ${Math.round(timeoutMs / 1000)}s.${runtime.port ? ` Make sure the app listens on 0.0.0.0:${runtime.port}.` : ""}${tail ? `\n--- last logs ---\n${tail}` : ""}`,
  );
}
