"use server";

import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requireServerAdmin } from "@/server/servers/access";
import { LABEL } from "@/server/docker/client";
import { logActivity } from "@/server/activity";
import { getServer, LOCAL_SERVER_ID } from "@/server/servers/context";
import { isSystemContainer } from "@/server/servers/resources";

const input = z.object({
  serverId: z.string().min(1).default(LOCAL_SERVER_ID),
  id: z.string().regex(/^[a-f0-9]{12,64}$/),
  action: z.enum(["start", "stop", "restart"]),
});

/** Start, stop or restart a container Serve does not manage, on any server. */
export async function controlUnmanagedContainer(raw: z.input<typeof input>) {
  return act(async () => {
    const { serverId, id, action } = input.parse(raw);
    const { ctx } = await requireServerAdmin(serverId);
    const server = await getServer(serverId).catch(() => {
      throw new UserError("Server not found.");
    });
    const container = server.docker.getContainer(id);
    const info = await container.inspect().catch(() => null);
    if (!info) throw new UserError("Container not found.");
    const labels = info.Config.Labels ?? {};
    const name = info.Name.replace(/^\//, "");
    if (labels[LABEL.service]) throw new UserError("This container belongs to a service. Use the service page instead.");
    if (isSystemContainer(labels, name)) throw new UserError("The dashboard's own containers cannot be controlled here.");
    if (action !== "stop") {
      // A container whose volume another running container uses (a service that took over its
      // data, say) must not start: two databases on one data directory corrupt it.
      const volumes = new Set((info.Mounts ?? []).filter((m) => m.Type === "volume" && m.Name && m.RW !== false).map((m) => m.Name as string));
      if (volumes.size) {
        const running = await server.docker.listContainers();
        const other = running.find((c) => c.Id !== info.Id && (c.Mounts ?? []).some((m) => m.Type === "volume" && m.Name && volumes.has(m.Name)));
        if (other) {
          const otherName = other.Names[0]?.replace(/^\//, "") ?? other.Id.slice(0, 12);
          throw new UserError(
            `${otherName} is running on the same data${other.Labels[LABEL.service] ? " (it is a Serve service)" : ""}. Stop it first: two containers on one data directory corrupt it.`,
          );
        }
      }
    }
    if (action === "start") await container.start();
    else if (action === "stop") await container.stop({ t: 15 });
    else await container.restart({ t: 10 });
    const verb = action === "stop" ? "Stopped" : action === "start" ? "Started" : "Restarted";
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: `server.container.${action}`,
      message: `${verb} container ${name}${server.local ? "" : ` on ${server.name}`}`,
    });
    return null;
  });
}
