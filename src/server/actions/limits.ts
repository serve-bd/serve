"use server";

import { eq } from "drizzle-orm";
import { act, UserError } from "@/server/action";
import { requireInstanceAdmin } from "@/server/auth";
import { db, schema } from "@/server/db";
import { logActivity } from "@/server/activity";
import { updateSettings } from "@/server/settings";
import { normalizeLimits, type OrgLimits } from "@/lib/limits";

/** Set an organization's own limits, or pass null to follow the instance defaults again. */
export async function saveOrgLimits(organizationId: string, limits: OrgLimits | null) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    const [org] = await db.select({ id: schema.organization.id, name: schema.organization.name }).from(schema.organization).where(eq(schema.organization.id, organizationId));
    if (!org) throw new UserError("Organization not found.");
    const next = limits ? normalizeLimits(limits) : {};
    await db
      .insert(schema.organizationLimit)
      .values({ organizationId, custom: !!limits, limits: next })
      .onConflictDoUpdate({ target: schema.organizationLimit.organizationId, set: { custom: !!limits, limits: next, notified: [] } });
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "org.limits",
      message: limits ? `Changed the limits of ${org.name}` : `${org.name} follows the default limits again`,
    });
    return null;
  });
}

/** Limits for every organization without its own. */
export async function saveDefaultOrgLimits(limits: OrgLimits) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    await updateSettings({ defaultOrgLimits: normalizeLimits(limits) });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "org.limits", message: "Changed the default organization limits" });
    return null;
  });
}
