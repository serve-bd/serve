import { dockerRestartPolicy } from "@/server/deploy/containers";
import { LABEL } from "@/server/docker/client";
import { type Stats, statsToSample } from "@/server/metrics";
import { getServer, serverOf } from "@/server/servers/context";
import { runServerIds } from "@/server/deploy/distribution";
import type { DistributionConfig } from "@/server/services/types";
import { maskCommand } from "@/server/security";

type Service = Parameters<typeof serverOf>[0] & { id: string; type: string; distribution: DistributionConfig | null };

/**
 * A container of the service, on its own server or (an app's replica) on one of its extra servers.
 * Any other server is refused: the id names the server to look on, not what may be read there.
 */
async function ownContainer(service: Service, containerId: string, serverId?: string | null) {
  const extra = serverId && serverId !== service.serverId;
  if (extra && !(service.type === "app" && runServerIds(service.serverId, service.distribution).includes(serverId))) return null;
  const { docker } = extra ? await getServer(serverId) : await serverOf(service);
  const container = docker.getContainer(containerId);
  const info = await container.inspect().catch(() => null);
  if (!info || info.Config.Labels?.[LABEL.service] !== service.id) return null;
  return { container, info };
}

/** Everything the container details dialog shows. Environment values are never included. */
export async function containerDetails(service: Service, containerId: string, serverId?: string | null) {
  const own = await ownContainer(service, containerId, serverId);
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
    command: maskCommand([...(info.Config.Entrypoint ?? []), ...(info.Config.Cmd ?? [])]).join(" ") || null,
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

export async function restartOwnContainer(service: Service & { type: string; runtime: { restartPolicy: string } }, containerId: string, serverId?: string | null) {
  const own = await ownContainer(service, containerId, serverId);
  if (!own) return false;
  // A replica the crash limit stopped has restart policy "no": give it the service's policy back.
  if (service.type === "app") await own.container.update({ RestartPolicy: dockerRestartPolicy(service.runtime.restartPolicy) }).catch(() => {});
  await own.container.restart({ t: 10 });
  return true;
}
