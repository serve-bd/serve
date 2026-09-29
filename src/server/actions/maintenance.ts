"use server";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { logActivity } from "@/server/activity";
import { serviceInOrg } from "@/server/services/access";
import { isCidr, MAINTENANCE_DEFAULTS } from "@/server/services/maintenance";
import type { MaintenanceConfig } from "@/server/services/types";
import { syncServiceProxy } from "@/server/proxy/nginx";

const maintenanceSchema = z.object({
  enabled: z.boolean(),
  title: z.string().trim().max(120).optional(),
  message: z.string().trim().max(2000).optional(),
  allow: z
    .array(z.string().trim())
    .max(50)
    .optional()
    .transform((list) => (list ?? []).filter(Boolean))
    .refine((list) => list.every(isCidr), "Use IP addresses or CIDR ranges, like 203.0.113.7 or 10.0.0.0/8."),
  retryAfterMinutes: z.number().int().min(1).max(10080).optional(),
});

/** Turn maintenance mode on or off (and save its page), then update the proxy right away. */
export async function setMaintenance(serviceId: string, input: z.input<typeof maintenanceSchema>) {
  return act(async () => {
    const ctx = await requireOrg();
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type === "database") throw new UserError("Databases have no domains to put in maintenance.");
    const data = maintenanceSchema.parse(input);
    const previous = service.maintenance ?? null;
    const next: MaintenanceConfig = {
      enabled: data.enabled,
      title: data.title ?? previous?.title ?? MAINTENANCE_DEFAULTS.title,
      message: data.message ?? previous?.message ?? MAINTENANCE_DEFAULTS.message,
      allow: input.allow !== undefined ? data.allow : (previous?.allow ?? []),
      retryAfterMinutes: data.retryAfterMinutes ?? previous?.retryAfterMinutes ?? MAINTENANCE_DEFAULTS.retryAfterMinutes,
      since: data.enabled ? (previous?.enabled ? (previous.since ?? new Date().toISOString()) : new Date().toISOString()) : null,
    };
    await db.update(schema.service).set({ maintenance: next }).where(eq(schema.service.id, serviceId));
    try {
      await syncServiceProxy(serviceId);
    } catch (error) {
      // The proxy rejected the change: keep what it serves and what Serve shows the same.
      await db.update(schema.service).set({ maintenance: previous }).where(eq(schema.service.id, serviceId));
      throw new UserError(`The proxy did not accept the maintenance page: ${(error as Error).message}`);
    }
    if (next.enabled !== !!previous?.enabled) {
      await logActivity({
        userId: ctx.user.id,
        organizationId: ctx.org.id,
        projectId: service.projectId,
        targetType: "service",
        targetId: service.id,
        action: next.enabled ? "service.maintenance.on" : "service.maintenance.off",
        message: next.enabled ? `Turned on maintenance mode for ${service.name}` : `Turned off maintenance mode for ${service.name}`,
      });
    }
    return { enabled: next.enabled };
  });
}
