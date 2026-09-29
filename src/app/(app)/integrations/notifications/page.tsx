import { desc, eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import { notifyEvents } from "@/server/notify";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { NotificationChannels } from "./channels";

export const metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const ctx = await requireOrg();
  const rows = await db.select().from(schema.notificationChannel).where(eq(schema.notificationChannel.organizationId, ctx.org.id)).orderBy(desc(schema.notificationChannel.createdAt));
  return (
    <>
      <PageHeader title="Notifications" description="Get told when deployments fail, services crash, backups run or certificates renew." />
      <PageBody>
        <NotificationChannels
          isAdmin={ctx.isAdmin}
          events={notifyEvents}
          channels={rows.map((c) => ({
            id: c.id,
            name: c.name,
            kind: c.kind,
            enabled: c.enabled,
            events: c.events,
            config: ctx.isAdmin ? (JSON.parse(decryptOrNull(c.config) ?? "{}") as Record<string, string>) : {},
          }))}
        />
      </PageBody>
    </>
  );
}
