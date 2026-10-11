"use server";

import { eq } from "drizzle-orm";
import { act, UserError } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { serviceInOrg } from "@/server/services/access";
import { applyServeConfig } from "@/server/services/serve-config";
import { defaultBuild, defaultRuntime } from "@/server/services/types";
import { serveConfigFrom } from "@/lib/serve-config";
import { logActivity } from "@/server/activity";

/** Puts the values of the last applied serve.json back over changes made in the dashboard. Applies on the next deploy. */
export async function resetToServeConfig(serviceId: string) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    const file = service.configFile;
    if (!file) throw new UserError("This service has no serve.json applied.");
    const quiet = { step: () => {}, line: () => {} };
    try {
      await applyServeConfig(
        service,
        { path: file.path, text: file.text },
        { deploymentId: file.deploymentId, commitSha: file.commitSha, organizationId: ctx.org.id, log: quiet, tasksNow: true },
      );
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    await logActivity({
      userId: ctx.user.id,
      action: "service.config_reset",
      message: `Put the ${file.path} values back on ${service.name}`,
      targetType: "service",
      targetId: serviceId,
      projectId: service.projectId,
      organizationId: ctx.org.id,
    });
    return { ok: true };
  });
}

/** The service's settings written as a serve.json, to start one from what the dashboard has. */
export async function exportServeConfig(serviceId: string) {
  return act(async () => {
    // Files mounted into the app can hold private settings: the same people who can change them.
    const ctx = await requirePermission("services.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type !== "app") throw new UserError("serve.json is for apps built from Git or the CLI.");
    const tasks = await db.select().from(schema.scheduledTask).where(eq(schema.scheduledTask.serviceId, serviceId));
    const config = serveConfigFrom(
      {
        build: service.build ?? defaultBuild(),
        runtime: service.runtime,
        // Tasks that pick a container belong to stacks; an app has one kind of container.
        tasks: tasks.map((t) => ({ name: t.name, schedule: t.schedule, command: t.command, timeoutSeconds: t.timeoutSeconds, enabled: t.enabled })),
      },
      { build: defaultBuild(), runtime: defaultRuntime(null) },
    );
    return { text: `${JSON.stringify(config, null, 2)}\n` };
  });
}
