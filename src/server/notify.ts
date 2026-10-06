import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";

export type { NotifyEvent } from "@/lib/notifications";
export { notify, type NotifyInput } from "@/server/notifications/deliver";

/** Organization that owns a service (via its project). */
export async function orgOfService(serviceId: string) {
  const [row] = await db
    .select({ organizationId: schema.project.organizationId })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(eq(schema.service.id, serviceId));
  return row?.organizationId ?? null;
}
