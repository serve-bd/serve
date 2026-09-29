"use server";

import { eq } from "drizzle-orm";
import { act, UserError } from "@/server/action";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { logActivity } from "@/server/activity";
import { serviceInOrg } from "@/server/services/access";
import { buildProxyConfig, proxyInputSchema, type ProxyInput } from "@/server/services/proxy-config";
import { generatedSite, ProxyConfigError, proxyStateOf, syncServiceProxy } from "@/server/proxy/nginx";
import { proxyLabels, type RunningKind } from "@/server/proxy/config";
import { getServer } from "@/server/servers/context";

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
        .filter((l) => l && !/test failed|syntax is ok/.test(l) && !/^\{"level":"(info|warn|debug)"/.test(l)),
    ),
  ];
  return lines.slice(0, 3).join(" ") || "The proxy rejected the configuration.";
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
    // Raw directives run inside the proxy on the server, so they are for server administrators only.
    for (const key of ["customDirectives", "caddyDirectives", "traefikMiddlewares"] as const) {
      if ((next[key] ?? null) !== (previous?.[key] ?? null) && next[key] && !ctx.isInstanceAdmin) {
        throw new UserError("Only Root organization admins can add custom proxy directives.");
      }
    }

    await db.update(schema.service).set({ proxy: next }).where(eq(schema.service.id, serviceId));
    try {
      await syncServiceProxy(serviceId);
    } catch (error) {
      await db.update(schema.service).set({ proxy: previous }).where(eq(schema.service.id, serviceId));
      if (error instanceof ProxyConfigError) {
        const { kind } = await proxyStateOf(service.serverId);
        throw new UserError(`${proxyLabels[kind]} rejected these options: ${nginxMessage(error.message)}`);
      }
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

async function customTarget(serviceId: string) {
  const ctx = await requireOrg();
  if (!ctx.isInstanceAdmin) throw new UserError("Only Root organization admins can change the proxy configuration of a service.");
  const { service } = await serviceInOrg(serviceId, ctx.org.id);
  if (service.type === "database") throw new UserError("Databases are reached over TCP; the proxy does not serve them.");
  const { kind } = await proxyStateOf(service.serverId);
  return { ctx, service, kind };
}

/** The configuration Serve generates for this service with the server's current proxy. */
export async function getServiceProxyPreview(serviceId: string) {
  return act(async () => {
    const { service, kind } = await customTarget(serviceId);
    if (kind === "none") return { kind, generated: null as string | null, custom: null as string | null };
    const generated = await generatedSite(kind, serviceId, await getServer(service.serverId));
    return { kind, generated, custom: service.proxyCustom?.[kind] ?? null };
  });
}

/**
 * Replace the generated site with a custom one for the current proxy (or go back
 * to the generated one with `null`). The proxy validates it; a rejected file is restored.
 */
export async function saveServiceProxyCustom(serviceId: string, content: string | null) {
  return act(async () => {
    const { ctx, service, kind } = await customTarget(serviceId);
    if (kind === "none") throw new UserError("This server runs no proxy.");
    if (content !== null && (!content.trim() || content.length > 100_000 || content.includes("\u0000")))
      throw new UserError("Enter the configuration (at most 100,000 characters).");
    const previous = service.proxyCustom ?? null;
    const next: Partial<Record<RunningKind, string>> = { ...previous };
    if (content === null) delete next[kind];
    else next[kind] = content;
    const value = Object.keys(next).length ? next : null;
    await db.update(schema.service).set({ proxyCustom: value }).where(eq(schema.service.id, serviceId));
    try {
      await syncServiceProxy(serviceId);
    } catch (error) {
      await db.update(schema.service).set({ proxyCustom: previous }).where(eq(schema.service.id, serviceId));
      await syncServiceProxy(serviceId).catch(() => {});
      if (error instanceof ProxyConfigError) throw new UserError(`${proxyLabels[kind]} rejected this configuration. Nothing was changed.\n${nginxMessage(error.message)}`);
      throw new UserError(`The proxy could not be updated: ${(error as Error).message}`);
    }
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "service.proxy",
      targetType: "service",
      targetId: service.id,
      message: content === null ? `Reset the proxy configuration of ${service.name}` : `Set a custom ${proxyLabels[kind]} configuration for ${service.name}`,
    });
    return null;
  });
}
