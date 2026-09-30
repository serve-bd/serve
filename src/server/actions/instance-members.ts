"use server";

import { and, eq, sql } from "drizzle-orm";
import { act, UserError } from "@/server/action";
import { ForbiddenError, isRootOwner, type OrgContext, requireInstanceAdmin } from "@/server/auth";
import { db, schema } from "@/server/db";
import { newId } from "@/server/id";
import { logActivity } from "@/server/activity";
import { getSetting } from "@/server/settings";
import { memberRoleFor } from "@/lib/permissions";
import { organizationRoles } from "@/server/permissions";

/**
 * Members of any organization, managed from Settings by admins of the Root organization. The Root
 * organization itself only by its owners: an admin must not make themselves or others owner there.
 */
async function guard(organizationId: string) {
  const ctx = await requireInstanceAdmin();
  const [org] = await db.select({ id: schema.organization.id, name: schema.organization.name }).from(schema.organization).where(eq(schema.organization.id, organizationId));
  if (!org) throw new UserError("Organization not found.");
  // The Root role itself: `ctx.role` is the role in the active organization, which they may own.
  if (org.id === (await getSetting("rootOrganizationId")) && !(await isRootOwner(ctx.user.id))) {
    throw new ForbiddenError("Only owners of the Root organization change its members here. Use Organization → Members instead.");
  }
  return { ctx, org };
}

async function roleIn(organizationId: string, roleId: string) {
  const role = (await organizationRoles(organizationId)).find((r) => r.id === roleId);
  if (!role) throw new UserError("That role does not exist in this organization.");
  return role;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Runs `fn` with the organization's owners locked, so two changes at once cannot remove the last owner. */
function withOwnersLocked<T>(organizationId: string, fn: (tx: Tx) => Promise<T>) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`serve-owners:${organizationId}`}))`);
    return fn(tx);
  });
}

async function ownerCount(organizationId: string, tx: Tx | typeof db = db) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.role, "owner")));
  return row?.n ?? 0;
}

async function memberOf(organizationId: string, memberId: string) {
  const [m] = await db
    .select({ id: schema.member.id, role: schema.member.role, userId: schema.member.userId, email: schema.user.email })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(and(eq(schema.member.id, memberId), eq(schema.member.organizationId, organizationId)));
  if (!m) throw new UserError("Member not found.");
  return m;
}

const log = (ctx: OrgContext, organizationId: string, action: string, message: string) => logActivity({ userId: ctx.user.id, organizationId, action, message });

/** Add someone who already has an account to an organization, without an invite. */
export async function addUserToOrganization(organizationId: string, userId: string, roleId: string) {
  return act(async () => {
    const { ctx, org } = await guard(organizationId);
    const role = await roleIn(org.id, roleId);
    const [user] = await db.select({ id: schema.user.id, email: schema.user.email }).from(schema.user).where(eq(schema.user.id, userId));
    if (!user) throw new UserError("User not found.");
    const base = memberRoleFor(role.id);
    const [row] = await db
      .insert(schema.member)
      .values({ id: newId(), organizationId: org.id, userId: user.id, role: base, roleId: base === "member" ? role.id : null })
      .onConflictDoNothing()
      .returning({ id: schema.member.id });
    if (!row) throw new UserError(`${user.email} is already a member of ${org.name}.`);
    // An invite still waiting for this person is no longer needed.
    await db
      .update(schema.invitation)
      .set({ status: "canceled" })
      .where(and(eq(schema.invitation.organizationId, org.id), sql`lower(${schema.invitation.email}) = lower(${user.email})`, eq(schema.invitation.status, "pending")));
    await log(ctx, org.id, "member.added", `Added ${user.email} to ${org.name} as ${role.name}`);
    return null;
  });
}

/** Change the role of a member of any organization. */
export async function setOrganizationMemberRole(organizationId: string, memberId: string, roleId: string) {
  return act(async () => {
    const { ctx, org } = await guard(organizationId);
    const m = await memberOf(org.id, memberId);
    const role = await roleIn(org.id, roleId);
    const base = memberRoleFor(role.id);
    await withOwnersLocked(org.id, async (tx) => {
      if (m.role === "owner" && base !== "owner" && (await ownerCount(org.id, tx)) <= 1) throw new UserError("An organization needs at least one owner.");
      await tx
        .update(schema.member)
        .set({ role: base, roleId: base === "member" ? role.id : null, ...(base === "member" ? {} : { projectIds: null }) })
        .where(eq(schema.member.id, m.id));
    });
    await log(ctx, org.id, "member.role", `Changed the role of ${m.email} in ${org.name} to ${role.name}`);
    return null;
  });
}

/** Remove a member from any organization. Their account stays. */
export async function removeOrganizationMember(organizationId: string, memberId: string) {
  return act(async () => {
    const { ctx, org } = await guard(organizationId);
    const m = await memberOf(org.id, memberId);
    await withOwnersLocked(org.id, async (tx) => {
      if (m.role === "owner" && (await ownerCount(org.id, tx)) <= 1) throw new UserError("An organization needs at least one owner. Make someone else owner first.");
      await tx.delete(schema.member).where(eq(schema.member.id, m.id));
    });
    await log(ctx, org.id, "member.removed", `Removed ${m.email} from ${org.name}`);
    return null;
  });
}
