"use server";

import { requireServerAdmin } from "@/server/servers/access";

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { newId } from "@/server/id";
import { logActivity } from "@/server/activity";
import { serviceInOrg } from "@/server/services/access";
import { MONITOR_INTERVALS } from "@/server/monitoring/config";
import { parseExpectedStatus } from "@/server/monitoring/state";
import { clearRequestLog, requestLogConfig } from "@/server/request-log";

const monitorSchema = z.object({
  enabled: z.boolean(),
  kind: z.enum(["http", "container"]),
  url: z
    .string()
    .trim()
    .max(2000)
    .refine((v) => !v || /^https?:\/\/[^\s]+$/i.test(v), "Use a full http:// or https:// URL")
    .optional()
    .nullable(),
  path: z
    .string()
    .trim()
    .max(500)
    .regex(/^\/[^\s]*$/, "Start the path with /")
    .default("/"),
  expectedStatus: z
    .string()
    .trim()
    .max(60)
    .refine((v) => !!parseExpectedStatus(v), "Use codes and ranges like 200-399 or 200,204 or 2xx"),
  keyword: z.string().trim().max(200).optional().nullable(),
  intervalSeconds: z.number().refine((v) => (MONITOR_INTERVALS as readonly number[]).includes(v), "Pick an interval from the list"),
  timeoutMs: z.number().int().min(1000).max(30_000),
  failureThreshold: z.number().int().min(1).max(10),
});

/** Create or update the uptime check of a service. */
export async function saveMonitor(serviceId: string, input: z.input<typeof monitorSchema>) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    const data = monitorSchema.parse(input);
    const values = { ...data, url: data.url || null, keyword: data.keyword || null };
    const [existing] = await db.select().from(schema.monitor).where(eq(schema.monitor.serviceId, serviceId));
    if (existing) {
      // New settings start a fresh status; the history stays. A service that is down stays down
      // until a check passes, so its incident is resolved (and channels told) as usual.
      const status = data.enabled ? (existing.status === "down" ? "down" : "pending") : "paused";
      await db
        .update(schema.monitor)
        .set({ ...values, status, consecutiveFailures: 0, lastCheckedAt: null })
        .where(eq(schema.monitor.id, existing.id));
      // A paused check is not an outage (like a service stopped on purpose).
      if (!data.enabled) {
        const { resolveIncident } = await import("@/server/monitoring/incidents");
        await resolveIncident(`down:${serviceId}`);
      }
    } else {
      await db.insert(schema.monitor).values({ id: newId(), serviceId, ...values, status: data.enabled ? "pending" : "paused" });
    }
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "monitor.update",
      targetType: "service",
      targetId: serviceId,
      message: `${data.enabled ? "Updated" : "Paused"} the uptime check of ${service.name}`,
    });
    return null;
  });
}

/** Run the check once now and return its result (does not wait for the worker). */
export async function checkMonitorNow(serviceId: string) {
  return act(async () => {
    const ctx = await requirePermission("projects.view");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    const [m] = await db.select().from(schema.monitor).where(eq(schema.monitor.serviceId, serviceId));
    if (!m) throw new UserError("Save the check first.");
    const { containerCheck, httpCheck, recordCheck } = await import("@/server/monitoring/checks");
    const result = m.kind === "container" ? await containerCheck(service) : await httpCheck(m, service.id);
    // Only members who may deploy change the monitor's state (incidents and alerts); others just see the result.
    // A paused check stays as it is: a test run does not open incidents for it.
    if (ctx.can("services.deploy") && m.enabled) await recordCheck(m, service, result);
    return result;
  });
}

const alertsSchema = z.object({
  enabled: z.boolean(),
  diskWarn: z.number().int().min(50).max(99),
  diskCritical: z.number().int().min(50).max(100),
  memory: z.number().int().min(50).max(100),
  cpu: z.number().int().min(50).max(100),
  cpuMinutes: z.number().int().min(1).max(60),
});

/** Resource alert thresholds of a server (Root admins). */
export async function saveServerAlerts(serverId: string, input: z.input<typeof alertsSchema>) {
  return act(async () => {
    const { ctx } = await requireServerAdmin(serverId);
    const data = alertsSchema.parse(input);
    if (data.diskCritical < data.diskWarn) throw new UserError("The critical disk level must be at or above the warning level.");
    const [server] = await db.select({ name: schema.server.name }).from(schema.server).where(eq(schema.server.id, serverId));
    if (!server) throw new UserError("Server not found.");
    await db
      .insert(schema.serverAlerts)
      .values({ serverId, config: data })
      .onConflictDoUpdate({ target: schema.serverAlerts.serverId, set: { config: data } });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.alerts", message: `Updated resource alerts of ${server.name}` });
    return null;
  });
}

const requestLogSchema = z.object({
  enabled: z.boolean(),
  days: z.number().int().min(1, "Keep requests for at least 1 day."),
  statuses: z.array(z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)])),
  ips: z.boolean(),
});

/** Turn the request log of a service on or off, and choose what it keeps and for how long. */
export async function saveRequestLog(serviceId: string, input: z.input<typeof requestLogSchema>) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type === "database") throw new UserError("Databases get no requests through the proxy.");
    if (service.parentServiceId) throw new UserError("Previews use the request log settings of their service.");
    const data = requestLogSchema.parse(input);
    if (data.enabled && !data.statuses.length) throw new UserError("Choose at least one kind of response to keep.");
    const config = requestLogConfig(data);
    await db.update(schema.service).set({ requestLog: config }).where(eq(schema.service.id, serviceId));
    // Visitor IPs turned off: the ones already kept go too, also those of its previews (kept under their own id).
    if (!config.ips && requestLogConfig(service.requestLog).ips) {
      const previews = await db.select({ id: schema.service.id }).from(schema.service).where(eq(schema.service.parentServiceId, serviceId));
      await db
        .update(schema.requestLog)
        .set({ ip: null })
        .where(and(inArray(schema.requestLog.serviceId, [serviceId, ...previews.map((p) => p.id)]), isNotNull(schema.requestLog.ip)));
    }
    const was = requestLogConfig(service.requestLog);
    if (was.enabled !== config.enabled) {
      await logActivity({
        userId: ctx.user.id,
        projectId: service.projectId,
        action: "service.request_log",
        targetType: "service",
        targetId: serviceId,
        message: `${config.enabled ? "Turned on" : "Turned off"} the request log of ${service.name}`,
      });
    }
    // Not undefined: the settings card takes undefined for a failed save and stays unsaved.
    return null;
  });
}

/** Delete every request kept for a service (and its previews). */
export async function deleteRequestLog(serviceId: string) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    const previews = await db.select({ id: schema.service.id }).from(schema.service).where(eq(schema.service.parentServiceId, serviceId));
    for (const id of [serviceId, ...previews.map((p) => p.id)]) await clearRequestLog(id);
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "service.request_log",
      targetType: "service",
      targetId: serviceId,
      message: `Deleted the request log of ${service.name}`,
    });
    return null;
  });
}
