import { LABEL } from "@/server/docker/client";
import { type Stats, statsToSample } from "@/server/metrics";
import { serverOf } from "@/server/servers/context";

type Service = Parameters<typeof serverOf>[0] & { id: string };

/** A container of this service, or null when the id belongs to something else. */
async function ownContainer(service: Service, containerId: string) {
  const { docker } = await serverOf(service);
  const container = docker.getContainer(containerId);
  const info = await container.inspect().catch(() => null);
  if (!info || info.Config.Labels?.[LABEL.service] !== service.id) return null;
  return { container, info };
}

/** Everything the container details dialog shows. Environment values are never included. */
export async function containerDetails(service: Service, containerId: string) {
  const own = await ownContainer(service, containerId);
  if (!own) return null;
  const { container, info } = own;
  const running = info.State.Running;
  const sample = running ? await (container.stats({ stream: false }) as unknown as Promise<Stats>).then(statsToSample).catch(() => null) : null;
  const labels = info.Config.Labels ?? {};
  const health = info.State.Health;
  return {
    id: info.Id,
    name: info.Name.replace(/^\//, ""),
    composeService: labels["com.docker.compose.service"] ?? null,
    image: info.Config.Image,
    imageId: info.Image,
    state: info.State.Status,
    startedAt: running ? info.State.StartedAt : null,
    finishedAt: !running && info.State.FinishedAt && !info.State.FinishedAt.startsWith("0001") ? info.State.FinishedAt : null,
    exitCode: running ? null : info.State.ExitCode,
    oomKilled: info.State.OOMKilled,
    error: info.State.Error || null,
    restarts: info.RestartCount,
    restartPolicy: info.HostConfig.RestartPolicy?.Name || "no",
    createdAt: info.Created,
    deployment: labels[LABEL.deployment] ?? null,
    health: health
      ? {
          status: health.Status,
          failingStreak: health.FailingStreak,
          last: health.Log?.at(-1) ? { exitCode: health.Log.at(-1)!.ExitCode, output: health.Log.at(-1)!.Output.trim().slice(-600), at: health.Log.at(-1)!.End } : null,
        }
      : null,
    command: [...(info.Config.Entrypoint ?? []), ...(info.Config.Cmd ?? [])].join(" ") || null,
    workingDir: info.Config.WorkingDir || null,
    user: info.Config.User || null,
    envKeys: (info.Config.Env ?? []).map((e) => e.split("=")[0]).sort(),
    resources: sample ? { cpu: sample.cpu, memory: sample.memory, memoryLimit: info.HostConfig.Memory || null } : null,
    networks: Object.entries(info.NetworkSettings.Networks ?? {}).map(([name, n]) => ({
      name,
      ip: n.IPAddress || null,
      aliases: [...new Set(((n.Aliases ?? []) as string[]).filter((a) => a !== info.Id.slice(0, 12) && a !== info.Config.Hostname))],
    })),
    ports: Object.entries(info.NetworkSettings.Ports ?? {}).map(([port, binds]) => ({
      container: port,
      published: (binds ?? []).map((b) => `${b.HostIp && b.HostIp !== "0.0.0.0" && b.HostIp !== "::" ? `${b.HostIp}:` : ""}${b.HostPort}`),
    })),
    mounts: (info.Mounts ?? []).map((m) => ({ type: m.Type, source: m.Type === "volume" ? (m.Name ?? m.Source) : m.Source, destination: m.Destination, readOnly: !m.RW })),
  };
}

export type ContainerDetails = NonNullable<Awaited<ReturnType<typeof containerDetails>>>;

export async function restartOwnContainer(service: Service, containerId: string) {
  const own = await ownContainer(service, containerId);
  if (!own) return false;
  await own.container.restart({ t: 10 });
  return true;
}
