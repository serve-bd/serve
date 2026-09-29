import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { type NotifyEvent, notifyEventCatalog } from "@/lib/notifications";

export type { NotifyEvent } from "@/lib/notifications";
export { notify, type NotifyInput } from "@/server/notifications/deliver";

export const notifyEvents: { id: NotifyEvent; label: string }[] = notifyEventCatalog.map((e) => ({ id: e.id, label: e.label }));

/** Organization that owns a service (via its project). */
export async function orgOfService(serviceId: string) {
  const [row] = await db
    .select({ organizationId: schema.project.organizationId })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(eq(schema.service.id, serviceId));
  return row?.organizationId ?? null;
}
