import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LABEL, listServiceContainers } from "@/server/docker/client";
import { logActivity } from "@/server/activity";
import { notify, orgOfService } from "@/server/notify";
import { serversOfService } from "@/server/servers/context";
import { crashLimitOf } from "@/server/services/types";
import { type CrashTrack, crashesInARow } from "./crash-count";

const store = globalThis as { __serveCrashTracks?: Map<string, CrashTrack> };
const tracks = (store.__serveCrashTracks ??= new Map());

/**
 * Stops app replicas that crashed `crashLimit` times in a row, so a broken release does not
 * restart forever. They stay stopped until the next deploy or start; the other replicas keep running.
 */
export async function enforceCrashLimits(reachable: Set<string>) {
  const apps = await db.select().from(schema.service).where(eq(schema.service.type, "app"));
  const seen = new Set<string>();
  const now = Date.now();
  for (const s of apps) {
    const limit = crashLimitOf(s.runtime);
    if (!limit || !s.currentDeploymentId || !["running", "restarting", "crashed"].includes(s.status)) continue;
    const servers = await serversOfService(s).catch(() => []);
    for (const server of servers) {
      if (!reachable.has(server.id)) continue;
      const containers = await listServiceContainers(s.id, true, server.docker).catch(() => []);
      for (const c of containers) {
        if (c.Labels[LABEL.deployment] !== s.currentDeploymentId) continue;
        seen.add(c.Id);
        // An exited replica (stopped by hand, or by this check) is left alone.
        if (c.State !== "running" && c.State !== "restarting") continue;
        const info = await server.docker
          .getContainer(c.Id)
          .inspect()
          .catch(() => null);
        if (!info) continue;
        const { crashes, track } = crashesInARow(
          tracks.get(c.Id),
          { restartCount: info.RestartCount ?? 0, running: info.State.Running && !info.State.Restarting, startedAt: Date.parse(info.State.StartedAt) || now },
          now,
        );
        tracks.set(c.Id, track);
        if (crashes < limit) continue;
        await server.docker
          .getContainer(c.Id)
          .stop({ t: 5 })
          .catch(() => {});
        tracks.delete(c.Id);
        const name = info.Name.replace(/^\//, "");
        const why = info.State.OOMKilled ? "It ran out of memory (OOM killed)." : `Last exit code ${info.State.ExitCode}.`;
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
