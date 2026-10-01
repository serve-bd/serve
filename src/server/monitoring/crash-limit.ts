import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LABEL } from "@/server/docker/client";
import { containerLister, withTimeout } from "./containers";

type ContainerList = Awaited<ReturnType<typeof containerLister>>;
import { logActivity } from "@/server/activity";
import { notify, orgOfService } from "@/server/notify";
import { serversOfService } from "@/server/servers/context";
import { crashLimitOf } from "@/server/services/types";
import { type CrashTrack, crashesInARow } from "./crash-count";

const store = globalThis as { __serveCrashTracks?: Map<string, CrashTrack>; __serveCrashSince?: number };
const tracks = (store.__serveCrashTracks ??= new Map());
/** When this process started counting; containers created before have restarts it did not see. */
const watchingSince = (store.__serveCrashSince ??= Date.now());

/**
 * Stops app replicas that crashed `crashLimit` times in a row, so a broken release does not
 * restart forever. They stay stopped until the next deploy or start; the other replicas keep running.
 */
export async function enforceCrashLimits(reachable: Set<string>, list?: ContainerList) {
  const containersOf = list ?? (await containerLister());
  const apps = await db.select().from(schema.service).where(eq(schema.service.type, "app"));
  const seen = new Set<string>();
  const stopped = new Set<string>();
  const now = Date.now();
  for (const s of apps) {
    const limit = crashLimitOf(s.runtime);
    if (!limit || !s.currentDeploymentId || !["running", "restarting", "crashed"].includes(s.status)) continue;
    const servers = await serversOfService(s).catch(() => []);
    for (const server of servers) {
      if (!reachable.has(server.id)) continue;
      const containers = (await containersOf(server.id).catch(() => [])).filter((c) => c.Labels[LABEL.service] === s.id);
      for (const c of containers) {
        if (c.Labels[LABEL.deployment] !== s.currentDeploymentId) continue;
        seen.add(c.Id);
        // An exited replica (stopped by hand, or by this check) is left alone.
        if (c.State !== "running" && c.State !== "restarting") continue;
        // An agent report has the restart count; otherwise the container is inspected.
        const live = () =>
          withTimeout(server.docker.getContainer(c.Id).inspect())
            .then((info) => ({
              name: info.Name.replace(/^\//, ""),
              restartCount: info.RestartCount ?? 0,
              running: info.State.Running && !info.State.Restarting,
              startedAt: Date.parse(info.State.StartedAt) || now,
              createdAt: Date.parse(info.Created) || 0,
              oomKilled: !!info.State.OOMKilled,
              exitCode: info.State.ExitCode,
            }))
            .catch(() => null);
        let info = c.info ? { ...c.info, startedAt: c.info.startedAt || now } : await live();
        if (!info) continue;
        let counted = crashesInARow(tracks.get(c.Id), info, now, watchingSince);
        // Stopping is acted on from a live look, not from a report that may be seconds old.
        if (counted.crashes >= limit && c.info) {
          info = await live();
          if (!info) continue;
          counted = crashesInARow(tracks.get(c.Id), info, now, watchingSince);
        }
        const { crashes, track } = counted;
        tracks.set(c.Id, track);
        if (crashes < limit) continue;
        // The last replica on the main server: mark the service crashed first, so the status check
        // does not send a second, vaguer "crashed" notice once it sees every container stopped.
        const othersUp = containers.some(
          (o) => o.Id !== c.Id && !stopped.has(o.Id) && o.Labels[LABEL.deployment] === s.currentDeploymentId && (o.State === "running" || o.State === "restarting"),
        );
        if (server.id === s.serverId && !othersUp && s.status !== "crashed") {
          const { setServiceStatus } = await import("@/server/deploy");
          await setServiceStatus(s.id, "crashed");
        }
        stopped.add(c.Id);
        // Restart policy "no" first: otherwise Docker starts it again when the daemon or machine restarts.
        // Starting or restarting the service puts the service's policy back.
        await server.docker
          .getContainer(c.Id)
          .update({ RestartPolicy: { Name: "no" } })
          .catch(() => {});
        await server.docker
          .getContainer(c.Id)
          .stop({ t: 5 })
          .catch(() => {});
        tracks.delete(c.Id);
        const name = info.name;
        const why = info.oomKilled ? "It ran out of memory (OOM killed)." : `Last exit code ${info.exitCode}.`;
        await logActivity({
          action: "service.crash-limit",
          projectId: s.projectId,
          targetType: "service",
          targetId: s.id,
          message: `Stopped ${name} of ${s.name} after ${crashes} crashes in a row`,
        }).catch(() => {});
        void notify(await orgOfService(s.id), "service.crashed", {
          ok: false,
          title: `${s.name} was stopped after ${crashes} crashes`,
          body: `${name} crashed ${crashes} times in a row, so it is no longer restarted. ${why} Fix the error and deploy again, or start the service.`,
          url: `/projects/${s.projectId}/services/${s.id}/logs`,
          status: "crashed",
          serviceId: s.id,
        });
      }
    }
  }
  for (const id of tracks.keys()) if (!seen.has(id)) tracks.delete(id);
}
