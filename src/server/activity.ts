import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { newId } from "@/server/id";

export async function logActivity(entry: {
  userId?: string | null;
  action: string;
  message: string;
  targetType?: string;
  targetId?: string;
  projectId?: string | null;
  organizationId?: string | null;
}) {
  let organizationId = entry.organizationId ?? null;
  if (!organizationId && entry.projectId) {
    const [p] = await db
      .select({ organizationId: schema.project.organizationId })
      .from(schema.project)
      .where(eq(schema.project.id, entry.projectId));
    organizationId = p?.organizationId ?? null;
  }
  await db
    .insert(schema.activity)
    .values({ id: newId(), ...entry, organizationId, userId: entry.userId ?? null, projectId: entry.projectId ?? null })
    .catch(() => {});
}
