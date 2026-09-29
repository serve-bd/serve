"use server";

import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requireInstanceAdmin } from "@/server/auth";
import { docker, LABEL } from "@/server/docker/client";
import { logActivity } from "@/server/activity";
import { isSystemContainer } from "@/app/(app)/server/resources/data";

const input = z.object({ id: z.string().regex(/^[a-f0-9]{12,64}$/), action: z.enum(["start", "stop", "restart"]) });

/** Start, stop or restart a container Serve does not manage. */
export async function controlUnmanagedContainer(raw: z.input<typeof input>) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    const { id, action } = input.parse(raw);
    const container = docker.getContainer(id);
    const info = await container.inspect().catch(() => null);
    if (!info) throw new UserError("Container not found.");
    const labels = info.Config.Labels ?? {};
    const name = info.Name.replace(/^\//, "");
    if (labels[LABEL.service]) throw new UserError("This container belongs to a Serve service. Use the service page instead.");
    if (isSystemContainer(labels, name)) throw new UserError("Serve's own containers cannot be controlled here.");
    if (action === "start") await container.start();
    else if (action === "stop") await container.stop({ t: 15 });
    else await container.restart({ t: 10 });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: `server.container.${action}`, message: `${action === "stop" ? "Stopped" : action === "start" ? "Started" : "Restarted"} container ${name}` });
    return null;
  });
}
