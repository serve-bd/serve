"use server";

import { and, eq, inArray } from "drizzle-orm";
import { act, UserError } from "@/server/action";
import { requireOrg, requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { logActivity } from "@/server/activity";
import { productName } from "@/server/branding";
import { type NotificationKind, providerInfo } from "@/lib/notifications";
import { applyTemplate, attemptDelivery, channelConfig, sampleMessage, sendTest } from "@/server/notifications/deliver";
import { ChannelConfigError, type ChannelInput, channelInput, validateChannelConfig } from "@/server/notifications/validate";

async function ownChannel(id: string, organizationId: string) {
  const [row] = await db
    .select()
    .from(schema.notificationChannel)
    .where(and(eq(schema.notificationChannel.id, id), eq(schema.notificationChannel.organizationId, organizationId)));
  if (!row) throw new UserError("Channel not found.");
  return row;
}

function checkConfig(kind: string, config: Record<string, string>, stored?: Record<string, string>) {
  try {
    return validateChannelConfig(kind, config, stored);
  } catch (e) {
    if (e instanceof ChannelConfigError) throw new UserError(e.message);
    throw e;
  }
}

/** Keeps only projects, environments and services of this organization. */
async function cleanScope(organizationId: string, scope: ChannelInput["scope"]) {
  if (!scope) return null;
  const [projects, environments, services] = await Promise.all([
    scope.projectIds.length
      ? db
          .select({ id: schema.project.id })
          .from(schema.project)
          .where(and(eq(schema.project.organizationId, organizationId), inArray(schema.project.id, scope.projectIds)))
      : [],
    scope.environmentIds.length
      ? db
          .select({ id: schema.environment.id })
          .from(schema.environment)
          .innerJoin(schema.project, eq(schema.environment.projectId, schema.project.id))
          .where(and(eq(schema.project.organizationId, organizationId), inArray(schema.environment.id, scope.environmentIds)))
      : [],
    scope.serviceIds.length
      ? db
          .select({ id: schema.service.id })
          .from(schema.service)
          .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
          .where(and(eq(schema.project.organizationId, organizationId), inArray(schema.service.id, scope.serviceIds)))
      : [],
  ]);
  return { projectIds: projects.map((r) => r.id), environmentIds: environments.map((r) => r.id), serviceIds: services.map((r) => r.id), includeGlobal: scope.includeGlobal };
}

export async function saveNotificationChannel(id: string | null, input: ChannelInput) {
  return act(async () => {
    const ctx = await requirePermission("integrations.manage");
    const data = channelInput.parse(input);
    if (!data.events.length) throw new UserError("Pick at least one event.");
    const existing = id ? await ownChannel(id, ctx.org.id) : null;
    // The type of a saved channel stays; a new type is a new channel.
    const kind = (existing?.kind ?? data.kind) as NotificationKind;
    if (!providerInfo(kind)) throw new UserError("Unknown channel type.");
    const config = checkConfig(kind, data.config, existing ? channelConfig(existing) : undefined);
    if (kind === "email") {
      const { isEmailConfigured } = await import("@/server/email/send");
      if (!(await isEmailConfigured())) throw new UserError("Email is not set up on this instance. A Root admin can configure it in Settings → Email.");
    }
    const values = {
      name: data.name,
      kind,
      config: encrypt(JSON.stringify(config)),
      events: data.events,
      scope: await cleanScope(ctx.org.id, data.scope),
      minSeverity: data.minSeverity,
      quietHours: data.quietHours,
      throttleMinutes: data.throttleMinutes,
      template: data.template && (data.template.title.trim() || data.template.body.trim()) ? data.template : null,
    };
    if (existing) {
      await db.update(schema.notificationChannel).set(values).where(eq(schema.notificationChannel.id, existing.id));
      return { id: existing.id };
    }
    const newIdValue = newId();
    await db.insert(schema.notificationChannel).values({ id: newIdValue, organizationId: ctx.org.id, ...values });
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "notification.create",
      message: `Added the ${providerInfo(kind)?.label} channel ${data.name}`,
      targetType: "notification",
      targetId: newIdValue,
    });
    return { id: newIdValue };
  });
}

export async function toggleNotificationChannel(id: string, enabled: boolean) {
  return act(async () => {
    const ctx = await requirePermission("integrations.manage");
    await ownChannel(id, ctx.org.id);
    await db.update(schema.notificationChannel).set({ enabled }).where(eq(schema.notificationChannel.id, id));
    return null;
  });
}

export async function deleteNotificationChannel(id: string) {
  return act(async () => {
    const ctx = await requirePermission("integrations.manage");
    const channel = await ownChannel(id, ctx.org.id);
    await db.delete(schema.notificationChannel).where(eq(schema.notificationChannel.id, id));
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "notification.delete",
      message: `Removed the channel ${channel.name}`,
      targetType: "notification",
      targetId: id,
    });
    return null;
  });
}

/**
 * Sends a test. With a form it tests the unsaved settings (saved secrets fill empty fields);
 * a saved channel's test is recorded in its history.
 */
export async function testNotificationChannel(id: string | null, form?: Pick<ChannelInput, "kind" | "config" | "template">) {
  return act(async () => {
    const ctx = form ? await requirePermission("integrations.manage") : await requireOrg();
    const existing = id ? await ownChannel(id, ctx.org.id) : null;
    const kind = existing?.kind ?? form?.kind ?? "";
    const config = form ? checkConfig(kind, form.config, existing ? channelConfig(existing) : undefined) : channelConfig(existing!);
    const template = form ? (form.template ?? null) : (existing?.template ?? null);
    const m = applyTemplate({ kind: kind as NotificationKind, template }, sampleMessage({ id: ctx.org.id, name: ctx.org.name }, kind, await productName()));
    let error: string | null = null;
    try {
      await sendTest(kind, config, m);
    } catch (e) {
      error = (e as Error).message.slice(0, 1000);
    }
    if (existing) {
      await db.insert(schema.notificationDelivery).values({
        id: m.id,
        organizationId: ctx.org.id,
        channelId: existing.id,
        event: "test",
        severity: "info",
        title: m.title,
        status: error ? "failed" : "sent",
        error,
        attempts: 1,
        groupKey: "test",
        message: m as unknown as Record<string, unknown>,
        test: true,
        sentAt: error ? null : new Date(),
      });
      await db
        .update(schema.notificationChannel)
        .set({ lastDeliveryAt: new Date(), lastDeliveryStatus: error ? "failed" : "sent", lastDeliveryError: error })
        .where(eq(schema.notificationChannel.id, existing.id));
    }
    if (error) throw new UserError(`The test failed: ${error}`);
    return null;
  });
}

/** Sends a failed delivery again now. */
export async function retryNotificationDelivery(deliveryId: string) {
  return act(async () => {
    const ctx = await requirePermission("integrations.manage");
    const [row] = await db
      .select()
      .from(schema.notificationDelivery)
      .where(and(eq(schema.notificationDelivery.id, deliveryId), eq(schema.notificationDelivery.organizationId, ctx.org.id)));
    if (!row) throw new UserError("Delivery not found.");
    if (row.status !== "failed") throw new UserError("Only failed deliveries can be sent again.");
    const updated = await attemptDelivery(row.id, { scheduleRetry: false });
    if (updated?.status === "failed") throw new UserError(`It failed again: ${updated.error ?? "unknown error"}`);
    return null;
  });
}
