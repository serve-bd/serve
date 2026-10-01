"use server";

import { and, eq } from "drizzle-orm";
import { act } from "@/server/action";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { layoutSchema, normalizeLayout } from "@/lib/dashboard";

/** Save the signed-in member's overview layout for this organization. */
export async function saveDashboard(input: unknown) {
  return act(async () => {
    const ctx = await requireOrg();
    const layout = normalizeLayout(layoutSchema.parse(input));
    await db
      .insert(schema.dashboardLayout)
      .values({ userId: ctx.user.id, organizationId: ctx.org.id, layout })
      .onConflictDoUpdate({ target: [schema.dashboardLayout.userId, schema.dashboardLayout.organizationId], set: { layout, updatedAt: new Date() } });
    return null;
  });
}

/** Go back to the default overview. */
export async function resetDashboard() {
  return act(async () => {
    const ctx = await requireOrg();
    await db.delete(schema.dashboardLayout).where(and(eq(schema.dashboardLayout.userId, ctx.user.id), eq(schema.dashboardLayout.organizationId, ctx.org.id)));
    return null;
  });
}
