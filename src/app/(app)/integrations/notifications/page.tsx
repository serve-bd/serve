import { desc, eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { NotificationChannels, type ChannelCard, type DeliveryRow } from "./channels";

export const metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const ctx = await requireOrg();
  const [rows, deliveries] = await Promise.all([
    db.select().from(schema.notificationChannel).where(eq(schema.notificationChannel.organizationId, ctx.org.id)).orderBy(desc(schema.notificationChannel.createdAt)),
    db
      .select({
        id: schema.notificationDelivery.id,
        channelId: schema.notificationDelivery.channelId,
        event: schema.notificationDelivery.event,
        severity: schema.notificationDelivery.severity,
        title: schema.notificationDelivery.title,
        status: schema.notificationDelivery.status,
        error: schema.notificationDelivery.error,
        attempts: schema.notificationDelivery.attempts,
        nextAttemptAt: schema.notificationDelivery.nextAttemptAt,
        test: schema.notificationDelivery.test,
        createdAt: schema.notificationDelivery.createdAt,
      })
      .from(schema.notificationDelivery)
      .where(eq(schema.notificationDelivery.organizationId, ctx.org.id))
      .orderBy(desc(schema.notificationDelivery.createdAt))
      .limit(100),
  ]);
  const channels: ChannelCard[] = rows.map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    enabled: c.enabled,
    events: c.events,
    minSeverity: c.minSeverity,
    scoped: !!c.scope && c.scope.projectIds.length + c.scope.environmentIds.length + c.scope.serviceIds.length > 0,
    quietHours: c.quietHours?.enabled ? `${c.quietHours.start}–${c.quietHours.end}` : null,
    throttleMinutes: c.throttleMinutes,
    lastDelivery: c.lastDeliveryAt ? { at: c.lastDeliveryAt.toISOString(), status: c.lastDeliveryStatus ?? "sent", error: c.lastDeliveryError } : null,
  }));
  const history: DeliveryRow[] = deliveries.map((d) => ({ ...d, createdAt: d.createdAt.toISOString(), nextAttemptAt: d.nextAttemptAt?.toISOString() ?? null }));
  return <NotificationChannels channels={channels} deliveries={history} isAdmin={ctx.can("integrations.manage")} />;
}
