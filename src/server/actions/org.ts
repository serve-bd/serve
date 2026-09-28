"use server";

import { headers } from "next/headers";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { auth, isInstanceAdmin, requireOrg, requireOrgAdmin, requireUser } from "@/server/auth";
import { db, schema } from "@/server/db";
import { createOrganization } from "@/server/accounts";
import { getSetting } from "@/server/settings";
import { newId } from "@/server/id";
import { logActivity } from "@/server/activity";
import type { MemberRole } from "@/server/db/schema";

export async function switchOrganization(organizationId: string) {
  return act(async () => {
    const user = await requireUser();
    const [m] = await db
      .select()
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, user.id)));
    if (!m) throw new UserError("You are not a member of that organization.");
    await auth.api.setActiveOrganization({ headers: await headers(), body: { organizationId } });
    return null;
  });
}

export async function createOrg(name: string) {
  return act(async () => {
    const user = await requireUser();
    const clean = z.string().trim().min(2, "Use at least 2 characters").max(60).parse(name);
    const allowed = (await getSetting("allowOrganizationCreation")) || (await isInstanceAdmin(user.id));
    if (!allowed) throw new UserError("Only Root organization admins can create organizations on this server.");
    const org = await createOrganization(clean, user.id);
    await auth.api.setActiveOrganization({ headers: await headers(), body: { organizationId: org.id } });
    await logActivity({ userId: user.id, organizationId: org.id, action: "org.created", message: `Created organization ${org.name}` });
    return { id: org.id };
  });
}

export async function updateOrg(input: { name: string; logo?: string | null }) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const name = z.string().trim().min(2).max(60).parse(input.name);
    await db.update(schema.organization).set({ name, logo: input.logo ?? null }).where(eq(schema.organization.id, ctx.org.id));
    return null;
  });
}

export async function deleteOrg() {
  return act(async () => {
    const ctx = await requireOrg();
    if (ctx.role !== "owner") throw new UserError("Only the owner can delete an organization.");
    if (ctx.isRoot) throw new UserError("The Root organization manages this server and cannot be deleted.");
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.project)
      .where(eq(schema.project.organizationId, ctx.org.id));
    if (n > 0) throw new UserError("Delete all projects in this organization first.");
    await db.delete(schema.organization).where(eq(schema.organization.id, ctx.org.id));
    return null;
  });
}

const roleSchema = z.enum(["owner", "admin", "member"]);

export async function inviteMember(input: { email: string; role: MemberRole }) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const email = z.email("Enter a valid email").parse(input.email.trim().toLowerCase());
    const role = roleSchema.parse(input.role);
    if (role === "owner" && ctx.role !== "owner") throw new UserError("Only owners can invite other owners.");
    const [already] = await db
      .select({ id: schema.member.id })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
      .where(and(eq(schema.member.organizationId, ctx.org.id), eq(schema.user.email, email)));
    if (already) throw new UserError("That person is already a member.");
    await db
      .update(schema.invitation)
      .set({ status: "canceled" })
      .where(and(eq(schema.invitation.organizationId, ctx.org.id), eq(schema.invitation.email, email), eq(schema.invitation.status, "pending")));
    const id = newId();
    await db.insert(schema.invitation).values({
      id,
      organizationId: ctx.org.id,
      email,
      role,
      status: "pending",
      inviterId: ctx.user.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "member.invited", message: `Invited ${email} as ${role}` });
    return { id };
  });
}

export async function revokeInvitation(id: string) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    await db
      .update(schema.invitation)
      .set({ status: "canceled" })
      .where(and(eq(schema.invitation.id, id), eq(schema.invitation.organizationId, ctx.org.id)));
    return null;
  });
}

async function ownerCount(orgId: string) {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.role, "owner")));
  return n;
}

export async function changeMemberRole(memberId: string, role: MemberRole) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const next = roleSchema.parse(role);
    const [m] = await db
      .select()
      .from(schema.member)
      .where(and(eq(schema.member.id, memberId), eq(schema.member.organizationId, ctx.org.id)));
    if (!m) throw new UserError("Member not found.");
    if ((m.role === "owner" || next === "owner") && ctx.role !== "owner") throw new UserError("Only owners can change owner roles.");
    if (m.role === "owner" && next !== "owner" && (await ownerCount(ctx.org.id)) <= 1) {
      throw new UserError("An organization needs at least one owner.");
    }
    await db.update(schema.member).set({ role: next }).where(eq(schema.member.id, memberId));
    return null;
  });
}

export async function removeMember(memberId: string) {
  return act(async () => {
    const ctx = await requireOrg();
    const [m] = await db
      .select()
      .from(schema.member)
      .where(and(eq(schema.member.id, memberId), eq(schema.member.organizationId, ctx.org.id)));
    if (!m) throw new UserError("Member not found.");
    const self = m.userId === ctx.user.id;
    if (!self && !ctx.isAdmin) throw new UserError("You need to be an admin to remove members.");
    if (m.role === "owner" && !self && ctx.role !== "owner") throw new UserError("Only owners can remove owners.");
    if (m.role === "owner" && (await ownerCount(ctx.org.id)) <= 1) {
      throw new UserError("An organization needs at least one owner. Make someone else owner first.");
    }
    await db.delete(schema.member).where(eq(schema.member.id, memberId));
    if (self) {
      await db.update(schema.session).set({ activeOrganizationId: null }).where(eq(schema.session.id, ctx.sessionId));
    }
    return { self };
  });
}
