"use server";

import { eq } from "drizzle-orm";
import { act, UserError } from "@/server/action";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { logActivity } from "@/server/activity";
import { serviceInOrg } from "@/server/services/access";
import { buildProxyConfig, proxyInputSchema, type ProxyInput } from "@/server/services/proxy-config";
import { ProxyConfigError, syncServiceProxy } from "@/server/proxy/nginx";

/** Nginx error text without paths and repeated lines. */
function nginxMessage(output: string) {
  const lines = [
    ...new Set(
      output
        .split("\n")
        .map((l) =>
          l
            .replace(/^nginx: /, "")
            .replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d /, "")
            .replace(/^\[(emerg|error|warn)\] (\d+#\d+: )?/, "")
            .replace(/ in \/etc\/nginx\/serve\/sites\/[^ ]+$/, "")
            .trim(),
        )
        .filter((l) => l && !/test failed|syntax is ok/.test(l)),
    ),
  ];
  return lines.slice(0, 3).join(" ") || "nginx rejected the configuration.";
}

/**
 * Save a service's HTTP options and apply them. nginx tests the new site
 * first; when it fails, the files and the saved options are both restored.
 */
export async function updateServiceProxy(serviceId: string, input: ProxyInput) {
  return act(async () => {
    const ctx = await requireOrg();
    if (!ctx.isAdmin) throw new UserError("Only organization admins can change HTTP options.");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type === "database") throw new UserError("Databases are reached over TCP; HTTP options do not apply.");

    const parsed = proxyInputSchema.safeParse(input);
    if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Invalid options.");
    const previous = service.proxy ?? null;
    let next;
    try {
      next = buildProxyConfig(parsed.data, previous);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    // Raw directives run inside nginx on the server, so they are for server administrators only.
    if ((next.customDirectives ?? null) !== (previous?.customDirectives ?? null) && next.customDirectives && !ctx.isInstanceAdmin) {
      throw new UserError("Only Root organization admins can add custom nginx directives.");
    }

    await db.update(schema.service).set({ proxy: next }).where(eq(schema.service.id, serviceId));
    try {
      await syncServiceProxy(serviceId);
    } catch (error) {
      await db.update(schema.service).set({ proxy: previous }).where(eq(schema.service.id, serviceId));
      if (error instanceof ProxyConfigError) throw new UserError(`nginx rejected these options: ${nginxMessage(error.message)}`);
      throw new UserError(`The proxy could not be updated: ${(error as Error).message}`);
    }
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "service.proxy",
      targetType: "service",
      targetId: service.id,
      message: `Updated HTTP options of ${service.name}`,
    });
    return null;
  });
}
