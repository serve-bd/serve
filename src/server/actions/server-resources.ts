"use server";

import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requireInstanceAdmin } from "@/server/auth";
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
    const ctx = await requireInstanceAdmin();
    const { serverId, id, action } = input.parse(raw);
    const server = await getServer(serverId).catch(() => {
      throw new UserError("Server not found.");
    });
    const container = server.docker.getContainer(id);
    const info = await container.inspect().catch(() => null);
    if (!info) throw new UserError("Container not found.");
    const labels = info.Config.Labels ?? {};
    const name = info.Name.replace(/^\//, "");
    if (labels[LABEL.service]) throw new UserError("This container belongs to a Serve service. Use the service page instead.");
    if (isSystemContainer(labels, name)) throw new UserError("Serve's own containers cannot be controlled here.");
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
