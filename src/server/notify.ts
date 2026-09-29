import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decrypt } from "@/server/crypto";
import { env } from "@/server/env";

export type NotifyEvent =
  | "deploy.success"
  | "deploy.failed"
  | "service.crashed"
  | "backup.failed"
  | "backup.success"
  | "certificate.failed"
  | "certificate.renewed"
  | "task.failed"
  | "server.disk"
  | "service.down"
  | "service.recovered"
  | "container.crashloop"
  | "server.resource";

export const notifyEvents: { id: NotifyEvent; label: string }[] = [
  { id: "deploy.success", label: "Deployment succeeded" },
  { id: "deploy.failed", label: "Deployment failed" },
  { id: "service.crashed", label: "Service crashed" },
  { id: "backup.success", label: "Backup succeeded" },
  { id: "backup.failed", label: "Backup failed" },
  { id: "certificate.renewed", label: "Certificate issued or renewed" },
  { id: "certificate.failed", label: "Certificate failed" },
  { id: "task.failed", label: "Scheduled task failed" },
  { id: "server.disk", label: "Server disk almost full" },
  { id: "service.down", label: "Uptime check failing" },
  { id: "service.recovered", label: "Uptime check recovered" },
  { id: "container.crashloop", label: "Container restarting repeatedly" },
  { id: "server.resource", label: "Server CPU, memory or disk high" },
];

type Message = { title: string; body: string; url?: string; ok: boolean };

export async function sendToChannel(channel: typeof schema.notificationChannel.$inferSelect, msg: Message) {
  const config = JSON.parse(decrypt(channel.config)) as Record<string, string>;
  const link = msg.url ? `${env.appUrl.replace(/\/$/, "")}${msg.url}` : undefined;
  if (channel.kind === "email") {
    const { sendNotificationEmail } = await import("@/server/email/messages");
    const to = config.to
      .split(/[,;\s]+/)
      .map((a) => a.trim())
      .filter(Boolean);
    const results = await Promise.allSettled(to.map((address) => sendNotificationEmail(address, { ...msg, url: link })));
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw new Error(`Notification email failed: ${(failed.reason as Error).message}`);
    return;
  }
  let res: Response;
  switch (channel.kind) {
    case "discord":
      res = await fetch(config.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          embeds: [
            {
              title: msg.title,
              description: msg.body,
              url: link,
              color: msg.ok ? 0x22c55e : 0xef4444,
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      });
      break;
    case "slack":
      res = await fetch(config.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `${msg.ok ? "✅" : "❌"} *${msg.title}*\n${msg.body}${link ? `\n<${link}|Open in Serve>` : ""}`,
        }),
      });
      break;
    case "telegram":
      res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: config.chatId,
          text: `${msg.ok ? "✅" : "❌"} ${msg.title}\n${msg.body}${link ? `\n${link}` : ""}`,
        }),
      });
      break;
    default:
      res = await fetch(config.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...msg, url: link, sentAt: new Date().toISOString() }),
      });
  }
  if (!res.ok) throw new Error(`Notification failed with HTTP ${res.status}`);
}

/** Organization that owns a service (via its project). */
export async function orgOfService(serviceId: string) {
  const [row] = await db
    .select({ organizationId: schema.project.organizationId })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(eq(schema.service.id, serviceId));
  return row?.organizationId ?? null;
}

export async function notify(organizationId: string | null, event: NotifyEvent, msg: Message) {
  if (!organizationId) return;
  const channels = await db
    .select()
    .from(schema.notificationChannel)
    .where(and(eq(schema.notificationChannel.enabled, true), eq(schema.notificationChannel.organizationId, organizationId)));
  await Promise.allSettled(channels.filter((c) => c.events.includes(event)).map((c) => sendToChannel(c, msg)));
}
