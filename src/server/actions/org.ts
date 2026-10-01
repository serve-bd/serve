"use server";

import { headers } from "next/headers";
import { isEmailConfigured } from "@/server/email/send";
import { sendInviteEmail } from "@/server/email/messages";
import { publicBaseUrl } from "@/server/git/github-app";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { authFor, isInstanceAdmin, type OrgContext, requireOrg, requireOrgAdmin, requireUser, requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { createOrganization } from "@/server/accounts";
import { getSetting } from "@/server/settings";
import { newId } from "@/server/id";
import { logActivity } from "@/server/activity";
import type { MemberRole } from "@/server/db/schema";
import { expandScopes, normalizeScopes } from "@/lib/api-scopes";
import { allowedScopes, BUILTIN_ROLE_INFO, canGrant, cannotMessage, isBuiltinRole, memberRoleFor, normalizePermissions } from "@/lib/permissions";
import { organizationRoles } from "@/server/permissions";

export async function switchOrganization(organizationId: string) {
  return act(async () => {
    const user = await requireUser();
    const [m] = await db
      .select()
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, user.id)));
    if (!m) throw new UserError("You are not a member of that organization.");
    await authFor(await headers()).api.setActiveOrganization({ headers: await headers(), body: { organizationId } });
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
    await authFor(await headers()).api.setActiveOrganization({ headers: await headers(), body: { organizationId: org.id } });
    await logActivity({ userId: user.id, organizationId: org.id, action: "org.created", message: `Created organization ${org.name}` });
    return { id: org.id };
  });
}

export async function updateOrg(input: { name: string; logo?: string | null }) {
  return act(async () => {
    const ctx = await requirePermission("members.manage");
    const name = z.string().trim().min(2).max(60).parse(input.name);
    const logo = z
      .string()
      .trim()
      .url()
      .max(2000)
      .regex(/^https?:\/\//i, "Use an http(s) address.")
      .nullable()
      .optional()
      .parse(input.logo || null);
    await db
      .update(schema.organization)
      .set({ name, logo: logo ?? null })
      .where(eq(schema.organization.id, ctx.org.id));
    return null;
  });
}

export async function deleteOrg() {
  return act(async () => {
    const ctx = await requireOrg();
    if (ctx.role !== "owner") throw new UserError("Only the owner can delete an organization.");
    if (ctx.isRoot) throw new UserError("The Root organization manages this server and cannot be deleted.");
    // Counted inside the transaction, under a lock, so nothing is created while the organization goes.
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`serve-org:${ctx.org.id}`}))`);
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.project).where(eq(schema.project.organizationId, ctx.org.id));
      if (n > 0) throw new UserError("Delete all projects in this organization first.");
      // Its servers would pass to the instance while its admins still have root on them.
      const [{ servers }] = await tx.select({ servers: sql<number>`count(*)::int` }).from(schema.server).where(eq(schema.server.ownerOrganizationId, ctx.org.id));
      if (servers > 0) throw new UserError("Remove this organization's servers first.");
      const [{ networks }] = await tx.select({ networks: sql<number>`count(*)::int` }).from(schema.privateNetwork).where(eq(schema.privateNetwork.organizationId, ctx.org.id));
      if (networks > 0) throw new UserError("Delete this organization's private networks first.");
      await tx.delete(schema.privateKey).where(eq(schema.privateKey.organizationId, ctx.org.id));
      await tx.delete(schema.organization).where(eq(schema.organization.id, ctx.org.id));
    });
    return null;
  });
}

/* -------------------------------------------------------------------------- */
/*                         Roles, members and project access                   */
/* -------------------------------------------------------------------------- */

/**
 * Whether the current member may hand out `roleId`. Owners give any role, admins any
 * but Owner, and anyone else with "manage members" only roles within their own permissions.
 */
async function assertCanGrant(ctx: OrgContext, roleId: string) {
  const roles = await organizationRoles(ctx.org.id);
  const role = roles.find((r) => r.id === roleId);
  if (!role) throw new UserError("That role does not exist.");
  if (roleId === "owner" && ctx.roleId !== "owner") throw new UserError("Only owners can make someone an owner.");
  if (roleId === "admin" && ctx.roleId !== "owner" && ctx.roleId !== "admin") throw new UserError("Only admins can make someone an admin.");
  if (!canGrant({ roleId: ctx.roleId, permissions: [...ctx.permissions] }, role)) throw new UserError("You can only give roles that have no more permissions than your own.");
  return role;
}

/** Only admins change admins and owners; only owners change owners. */
function assertCanChange(ctx: OrgContext, target: { role: string }) {
  if (target.role === "owner" && ctx.roleId !== "owner") throw new UserError("Only owners can change owners.");
  if (target.role === "admin" && !ctx.isAdmin) throw new UserError("Only admins can change admins.");
}

const roleIdSchema = z.string().trim().min(1).max(64);

export async function inviteMember(input: { email: string; roleId?: string; role?: MemberRole }) {
  return act(async () => {
    const ctx = await requirePermission("members.manage");
    const email = z.email("Enter a valid email").parse(input.email.trim().toLowerCase());
    const roleId = roleIdSchema.parse(input.roleId ?? (input.role === "member" ? "developer" : input.role) ?? "developer");
    const granted = await assertCanGrant(ctx, roleId);
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
    // Root admins add someone who already has an account at once, without an invite link.
    if (ctx.isInstanceAdmin) {
      const [existing] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email));
      if (existing) {
        await db
          .insert(schema.member)
          .values({ id: newId(), organizationId: ctx.org.id, userId: existing.id, role: memberRoleFor(roleId), roleId: memberRoleFor(roleId) === "member" ? roleId : null })
          .onConflictDoNothing();
        await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "member.added", message: `Added ${email} as ${granted.name}` });
        return { id: null, added: true, emailed: false, emailError: null };
      }
    }
    const id = newId();
    await db.insert(schema.invitation).values({
      id,
      organizationId: ctx.org.id,
      email,
      role: memberRoleFor(roleId),
      roleId: memberRoleFor(roleId) === "member" ? roleId : null,
      status: "pending",
      inviterId: ctx.user.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "member.invited", message: `Invited ${email} as ${granted.name}` });
    // With email set up, the invitation is sent too; the link is shown either way.
    let emailed = false;
    let emailError: string | null = null;
    if (await isEmailConfigured()) {
      try {
        await sendInviteEmail({
          to: email,
          organization: ctx.org.name,
          inviter: ctx.user.name || ctx.user.email,
          role: granted.name.toLowerCase(),
          url: `${await publicBaseUrl()}/invite/${id}`,
        });
        emailed = true;
      } catch (e) {
        emailError = (e as Error).message;
      }
    }
    return { id, added: false, emailed, emailError };
  });
}

export async function revokeInvitation(id: string) {
  return act(async () => {
    const ctx = await requirePermission("members.manage");
    await db
      .update(schema.invitation)
      .set({ status: "canceled" })
      .where(and(eq(schema.invitation.id, id), eq(schema.invitation.organizationId, ctx.org.id)));
    return null;
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Runs `fn` with the organization's owners locked, so two changes at once cannot remove the last owner. */
function withOwnersLocked<T>(organizationId: string, fn: (tx: Tx) => Promise<T>) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`serve-owners:${organizationId}`}))`);
    return fn(tx);
  });
}

async function ownerCount(orgId: string, tx: Tx | typeof db = db) {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.role, "owner")));
  return n;
}

async function orgMember(ctx: OrgContext, memberId: string) {
  const [m] = await db
    .select()
    .from(schema.member)
    .where(and(eq(schema.member.id, memberId), eq(schema.member.organizationId, ctx.org.id)));
  if (!m) throw new UserError("Member not found.");
  return m;
}

/** Give a member a built-in or custom role. */
export async function setMemberRole(memberId: string, roleId: string) {
  return act(async () => {
    const ctx = await requirePermission("members.manage");
    const next = roleIdSchema.parse(roleId);
    const m = await orgMember(ctx, memberId);
    assertCanChange(ctx, m);
    const role = await assertCanGrant(ctx, next);
    const base = memberRoleFor(next);
    await withOwnersLocked(ctx.org.id, async (tx) => {
      if (m.role === "owner" && base !== "owner" && (await ownerCount(ctx.org.id, tx)) <= 1) {
        throw new UserError(m.userId === ctx.user.id ? "Make someone else owner first." : "An organization needs at least one owner.");
      }
      await tx
        .update(schema.member)
        .set({ role: base, roleId: base === "member" ? next : null, ...(base === "member" ? {} : { projectIds: null }) })
        .where(eq(schema.member.id, memberId));
    });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "member.role", message: `Changed a member's role to ${role.name}` });
    return null;
  });
}

/** @deprecated Use setMemberRole; kept for callers that pass owner/admin/member. */
export async function changeMemberRole(memberId: string, role: MemberRole) {
  return setMemberRole(memberId, role === "member" ? "developer" : role);
}

/** Limit a member to some projects, or give back access to all (null). */
export async function setMemberProjects(memberId: string, projectIds: string[] | null) {
  return act(async () => {
    const ctx = await requirePermission("members.manage");
    const m = await orgMember(ctx, memberId);
    assertCanChange(ctx, m);
    if (m.role !== "member") throw new UserError("Owners and admins always reach every project.");
    let ids: string[] | null = null;
    if (projectIds) {
      const unique = [...new Set(z.array(z.string()).max(500).parse(projectIds))];
      if (!unique.length) throw new UserError("Choose at least one project, or give access to all projects.");
      const owned = await db
        .select({ id: schema.project.id })
        .from(schema.project)
        .where(and(eq(schema.project.organizationId, ctx.org.id), inArray(schema.project.id, unique)));
      if (owned.length !== unique.length) throw new UserError("One of the selected projects was not found.");
      // Someone limited to some projects cannot grant others.
      if (ctx.projectIds && unique.some((id) => !ctx.canAccessProject(id))) throw new UserError("You can only give access to projects you can reach.");
      ids = unique;
    } else if (ctx.projectIds) {
      throw new UserError("You can only give access to projects you can reach.");
    }
    await db.update(schema.member).set({ projectIds: ids }).where(eq(schema.member.id, memberId));
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "member.projects",
      message: ids ? `Limited a member to ${ids.length} project${ids.length === 1 ? "" : "s"}` : "Gave a member access to every project",
    });
    return null;
  });
}

export async function removeMember(memberId: string) {
  return act(async () => {
    const ctx = await requireOrg();
    const m = await orgMember(ctx, memberId);
    const self = m.userId === ctx.user.id;
    if (!self) {
      if (!ctx.can("members.manage")) throw new UserError(cannotMessage("members.manage"));
      assertCanChange(ctx, m);
    }
    await withOwnersLocked(ctx.org.id, async (tx) => {
      if (m.role === "owner" && (await ownerCount(ctx.org.id, tx)) <= 1) {
        throw new UserError("An organization needs at least one owner. Make someone else owner first.");
      }
      await tx.delete(schema.member).where(eq(schema.member.id, memberId));
    });
    if (self) {
      await db.update(schema.session).set({ activeOrganizationId: null }).where(eq(schema.session.id, ctx.sessionId));
    }
    return { self };
  });
}

const customRoleSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(40),
  description: z.string().trim().max(200).optional(),
  permissions: z.array(z.string()).max(50),
});

/** Create or update a custom role. Only admins define roles. */
export async function saveRole(roleId: string | null, input: z.input<typeof customRoleSchema>) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const data = customRoleSchema.parse(input);
    if (isBuiltinRole(data.name.toLowerCase())) throw new UserError(`"${data.name}" is the name of a built-in role.`);
    const permissions = normalizePermissions(data.permissions);
    const clash = (await organizationRoles(ctx.org.id)).find((r) => r.name.toLowerCase() === data.name.toLowerCase() && r.id !== roleId);
    if (clash) throw new UserError(`A role named ${clash.name} already exists.`);
    if (roleId) {
      const [row] = await db
        .update(schema.orgRole)
        .set({ name: data.name, description: data.description || null, permissions, updatedAt: new Date() })
        .where(and(eq(schema.orgRole.id, roleId), eq(schema.orgRole.organizationId, ctx.org.id), isNull(schema.orgRole.builtin)))
        .returning({ id: schema.orgRole.id });
      if (!row) throw new UserError("Role not found.");
    } else {
      roleId = newId();
      await db.insert(schema.orgRole).values({ id: roleId, organizationId: ctx.org.id, name: data.name, description: data.description || null, permissions });
    }
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "role.saved", message: `Saved the role ${data.name}` });
    return { id: roleId };
  });
}

/** Delete a custom role; its members become Viewers, so only when that gives them nothing more. */
export async function deleteRole(roleId: string) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const roles = await organizationRoles(ctx.org.id);
    const role = roles.find((r) => r.id === roleId && !r.builtin);
    const viewer = roles.find((r) => r.id === "viewer")!;
    const [{ members }] = await db
      .select({ members: sql<number>`count(*)::int` })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, ctx.org.id), eq(schema.member.roleId, roleId)));
    if (role && members && viewer.permissions.some((p) => !role.permissions.includes(p))) {
      throw new UserError(`Viewers here can do more than ${role.name}. Give its ${members} member${members === 1 ? "" : "s"} another role first.`);
    }
    const [row] = await db
      .delete(schema.orgRole)
      .where(and(eq(schema.orgRole.id, roleId), eq(schema.orgRole.organizationId, ctx.org.id), isNull(schema.orgRole.builtin)))
      .returning({ name: schema.orgRole.name });
    if (!row) throw new UserError("Role not found.");
    await db
      .update(schema.member)
      .set({ roleId: "viewer" })
      .where(and(eq(schema.member.organizationId, ctx.org.id), eq(schema.member.roleId, roleId)));
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "role.deleted", message: `Deleted the role ${row.name}` });
    return null;
  });
}

/** Adjust the built-in Developer role, for example to let developers see secret values. */
/** Permissions of a built-in role that organizations may adjust (Developer, Viewer). Owner and Admin stay complete. */
export async function saveBuiltinPermissions(role: string, permissions: string[]) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    if (!isBuiltinRole(role) || !BUILTIN_ROLE_INFO[role].editable) throw new UserError("This role cannot be changed.");
    const next = normalizePermissions(z.array(z.string()).max(50).parse(permissions));
    const name = BUILTIN_ROLE_INFO[role].name;
    await db
      .insert(schema.orgRole)
      .values({ id: newId(), organizationId: ctx.org.id, builtin: role, name, permissions: next })
      .onConflictDoUpdate({ target: [schema.orgRole.organizationId, schema.orgRole.builtin], set: { permissions: next, updatedAt: new Date() } });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "role.saved", message: `Changed the ${name} role` });
    return null;
  });
}

const tokenSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(60),
  scopes: z
    .array(z.string())
    .transform(normalizeScopes)
    .refine((s) => s.length > 0, "Choose at least one permission"),
  expiresInDays: z.number().int().min(1).max(3650).nullable(),
  projectIds: z.array(z.string()).max(200).nullable(),
});

/** Create a token for yourself. It can never do more than your role allows. */
export async function createApiToken(input: z.input<typeof tokenSchema>) {
  return act(async () => {
    const ctx = await requireOrg();
    const data = tokenSchema.parse(input);
    const allowed = allowedScopes(ctx.permissions, ctx.isAdmin);
    const denied = [...expandScopes(data.scopes)].filter((s) => !allowed.has(s));
    if (denied.length) throw new UserError(`Your role does not allow the ${denied.join(", ")} scope${denied.length === 1 ? "" : "s"}.`);
    let projectIds: string[] | null = null;
    if (data.projectIds?.length) {
      const owned = await db
        .select({ id: schema.project.id })
        .from(schema.project)
        .where(and(eq(schema.project.organizationId, ctx.org.id), inArray(schema.project.id, data.projectIds)));
      if (owned.length !== new Set(data.projectIds).size) throw new UserError("One of the selected projects was not found.");
      projectIds = owned.map((p) => p.id);
    }
    if (ctx.projectIds) {
      // Limited members only make tokens for projects they can reach.
      if (!projectIds) projectIds = ctx.projectIds;
      else if (projectIds.some((id) => !ctx.canAccessProject(id))) throw new UserError("You can only choose projects you can reach.");
    }
    const { randomSecret, sha256 } = await import("@/server/crypto");
    const token = `srv_${randomSecret(30)}`;
    await db.insert(schema.apiToken).values({
      id: newId(),
      organizationId: ctx.org.id,
      userId: ctx.user.id,
      name: data.name,
      tokenHash: sha256(token),
      prefix: token.slice(0, 10),
      scopes: data.scopes,
      projectIds,
      expiresAt: data.expiresInDays ? new Date(Date.now() + data.expiresInDays * 86_400_000) : null,
    });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "token.created", message: `Created API token "${data.name}" (${data.scopes.join(", ")})` });
    return { token };
  });
}

/** Revoke your own token, or anyone's with "manage members". */
export async function revokeApiToken(id: string) {
  return act(async () => {
    const ctx = await requireOrg();
    const own = ctx.can("members.manage") ? undefined : eq(schema.apiToken.userId, ctx.user.id);
    const [row] = await db
      .delete(schema.apiToken)
      .where(and(eq(schema.apiToken.id, id), eq(schema.apiToken.organizationId, ctx.org.id), own))
      .returning({ name: schema.apiToken.name });
    if (!row) throw new UserError("Token not found.");
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "token.revoked", message: `Revoked API token "${row.name}"` });
    return null;
  });
}
