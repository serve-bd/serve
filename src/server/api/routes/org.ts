import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/server/db";
import * as org from "@/server/actions/org";
import { organizationRoles } from "@/server/permissions";
import { getSetting } from "@/server/settings";
import { PERMISSION_INFO, PERMISSIONS } from "@/lib/permissions";
import { iso, page } from "../data";
import { ApiError, type ApiRoute, route, unwrap } from "../router";

export const orgRoutes: ApiRoute[] = [
  route({
    method: "GET",
    path: "/me",
    tag: "Token",
    summary: "This token",
    description: "Who the token acts as, its organization, what it may do now, and which projects it reaches.",
    needs: [],
    handler: async ({ auth }) => {
      const [[user], [organization], [token]] = await Promise.all([
        db.select({ id: schema.user.id, name: schema.user.name, email: schema.user.email }).from(schema.user).where(eq(schema.user.id, auth.userId)),
        db
          .select({ id: schema.organization.id, name: schema.organization.name, slug: schema.organization.slug })
          .from(schema.organization)
          .where(eq(schema.organization.id, auth.organizationId)),
        db
          .select({
            id: schema.apiToken.id,
            name: schema.apiToken.name,
            scopes: schema.apiToken.scopes,
            expiresAt: schema.apiToken.expiresAt,
            createdAt: schema.apiToken.createdAt,
          })
          .from(schema.apiToken)
          .where(eq(schema.apiToken.id, auth.tokenId)),
      ]);
      // Deleted while this request ran.
      if (!token) throw new ApiError(401, "This token no longer exists.");
      return {
        token: { id: token.id, name: token.name, granted: token.scopes, expiresAt: iso(token.expiresAt), createdAt: iso(token.createdAt) },
        user,
        organization,
        permissions: PERMISSIONS.filter((p) => auth.permissions.has(p)),
        admin: auth.admin,
        projectIds: auth.projectIds,
      };
    },
  }),
  route({
    method: "GET",
    path: "/permissions",
    tag: "Token",
    summary: "Every permission a token can have",
    needs: [],
    handler: async () => ({
      permissions: [...PERMISSIONS.map((p) => ({ id: p, ...PERMISSION_INFO[p] })), { id: "admin", label: "Admin", description: "Everything an organization admin may do." }],
    }),
  }),

  // Organization
  route({
    method: "GET",
    path: "/organization",
    tag: "Organization",
    summary: "The token's organization",
    needs: [],
    handler: async ({ auth }) => {
      const [o] = await db.select().from(schema.organization).where(eq(schema.organization.id, auth.organizationId));
      return { organization: { id: o.id, name: o.name, slug: o.slug, logo: o.logo, root: o.id === (await getSetting("rootOrganizationId")), createdAt: iso(o.createdAt) } };
    },
  }),
  route({
    method: "PATCH",
    path: "/organization",
    tag: "Organization",
    summary: "Rename the organization or change its logo",
    needs: ["admin"],
    body: z.object({ name: z.string(), logo: z.string().nullable().optional() }),
    handler: async ({ body }) => (await unwrap(org.updateOrg(body))) ?? { ok: true },
  }),

  // Members
  route({
    method: "GET",
    path: "/members",
    tag: "Members",
    summary: "List members",
    needs: ["projects.view"],
    handler: async ({ auth }) => {
      const rows = await db
        .select({ member: schema.member, user: { id: schema.user.id, name: schema.user.name, email: schema.user.email } })
        .from(schema.member)
        .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
        .where(eq(schema.member.organizationId, auth.organizationId));
      const roles = await organizationRoles(auth.organizationId);
      const { effectiveRoleId } = await import("@/lib/permissions");
      return {
        members: rows.map(({ member, user }) => {
          const roleId = effectiveRoleId(member.role, member.roleId);
          return {
            id: member.id,
            user,
            roleId,
            role: roles.find((r) => r.id === roleId)?.name ?? roleId,
            projectIds: member.projectIds?.length ? member.projectIds : null,
            joinedAt: iso(member.createdAt),
          };
        }),
      };
    },
  }),
  route({
    method: "PATCH",
    path: "/members/{memberId}",
    tag: "Members",
    summary: "Change a member's role or projects",
    description: "roleId: owner, admin, developer, viewer or a custom role id. projectIds: the projects they reach, null for every project.",
    needs: ["members.manage"],
    body: z.object({ roleId: z.string().optional(), projectIds: z.array(z.string()).nullable().optional() }),
    handler: async ({ params, body }) => {
      if (body.roleId) await unwrap(org.setMemberRole(params.memberId, body.roleId));
      if (body.projectIds !== undefined) await unwrap(org.setMemberProjects(params.memberId, body.projectIds));
      return { ok: true };
    },
  }),
  route({
    method: "DELETE",
    path: "/members/{memberId}",
    tag: "Members",
    summary: "Remove a member",
    needs: ["members.manage"],
    handler: async ({ params }) => (await unwrap(org.removeMember(params.memberId))) ?? { ok: true },
  }),
  route({
    method: "GET",
    path: "/invitations",
    tag: "Members",
    summary: "List open invitations",
    needs: ["members.manage"],
    handler: async ({ auth }) => {
      const rows = await db
        .select()
        .from(schema.invitation)
        .where(and(eq(schema.invitation.organizationId, auth.organizationId), eq(schema.invitation.status, "pending"), gt(schema.invitation.expiresAt, new Date())));
      return { invitations: rows.map((i) => ({ id: i.id, email: i.email, roleId: i.roleId ?? i.role, expiresAt: iso(i.expiresAt), createdAt: iso(i.createdAt) })) };
    },
  }),
  route({
    method: "POST",
    path: "/invitations",
    tag: "Members",
    summary: "Invite someone",
    description: "Sends the invitation email when email is set up. Someone who already has an account here joins at once.",
    needs: ["members.manage"],
    body: z.object({ email: z.string(), roleId: z.string().optional() }),
    status: 201,
    handler: async ({ body }) => unwrap(org.inviteMember(body)),
  }),
  route({
    method: "DELETE",
    path: "/invitations/{invitationId}",
    tag: "Members",
    summary: "Revoke an invitation",
    needs: ["members.manage"],
    handler: async ({ params }) => (await unwrap(org.revokeInvitation(params.invitationId))) ?? { ok: true },
  }),

  // Roles
  route({
    method: "GET",
    path: "/roles",
    tag: "Members",
    summary: "List roles",
    description: "The built-in roles and the organization's custom roles, with their permissions.",
    needs: ["projects.view"],
    handler: async ({ auth }) => ({ roles: await organizationRoles(auth.organizationId) }),
  }),
  route({
    method: "POST",
    path: "/roles",
    tag: "Members",
    summary: "Create a custom role",
    needs: ["admin"],
    body: z.object({ name: z.string(), description: z.string().optional(), permissions: z.array(z.string()) }),
    status: 201,
    handler: async ({ body }) => (await unwrap(org.saveRole(null, body))) ?? { ok: true },
  }),
  route({
    method: "PUT",
    path: "/roles/{roleId}",
    tag: "Members",
    summary: "Change a role",
    description: "A custom role takes name, description and permissions. The built-in Developer and Viewer roles only take permissions.",
    needs: ["admin"],
    body: z.object({ name: z.string().optional(), description: z.string().optional(), permissions: z.array(z.string()) }),
    handler: async ({ params, body }) => {
      if (params.roleId === "developer" || params.roleId === "viewer") return (await unwrap(org.saveBuiltinPermissions(params.roleId, body.permissions))) ?? { ok: true };
      return (await unwrap(org.saveRole(params.roleId, { name: body.name ?? "", description: body.description, permissions: body.permissions }))) ?? { ok: true };
    },
  }),
  route({
    method: "DELETE",
    path: "/roles/{roleId}",
    tag: "Members",
    summary: "Delete a custom role",
    needs: ["admin"],
    handler: async ({ params }) => (await unwrap(org.deleteRole(params.roleId))) ?? { ok: true },
  }),

  // Tokens: listed and revoked here; new tokens are made in the dashboard, where a person signs in.
  route({
    method: "GET",
    path: "/tokens",
    tag: "Token",
    summary: "List API tokens",
    description: "Your own tokens; every token of the organization with members.manage.",
    needs: [],
    handler: async ({ auth }) => {
      const rows = await db
        .select()
        .from(schema.apiToken)
        .where(and(eq(schema.apiToken.organizationId, auth.organizationId), auth.can("members.manage") ? undefined : eq(schema.apiToken.userId, auth.userId)))
        .orderBy(desc(schema.apiToken.createdAt));
      return {
        tokens: rows.map((t) => ({
          id: t.id,
          name: t.name,
          prefix: t.prefix,
          userId: t.userId,
          granted: t.scopes,
          projectIds: t.projectIds,
          expiresAt: iso(t.expiresAt),
          lastUsedAt: iso(t.lastUsedAt),
          createdAt: iso(t.createdAt),
        })),
      };
    },
  }),
  route({
    method: "POST",
    path: "/tokens",
    tag: "Token",
    summary: "Create an API token",
    description:
      "A token for the same person, as in Keys & tokens: scopes are permissions (or admin), never more than this token has; projectIds limits it to projects (a token limited to projects only makes tokens for those). expiresInDays: 1 to 3650, or null for none. A token that expires itself only makes tokens that expire no later. The secret (token) is in the answer once.",
    needs: [],
    body: z.object({
      name: z.string(),
      scopes: z.array(z.string()).min(1),
      projectIds: z.array(z.string()).nullable().optional(),
      expiresInDays: z.number().int().nullable().optional(),
    }),
    status: 201,
    handler: async ({ auth, body }) => {
      const [self] = await db.select({ expiresAt: schema.apiToken.expiresAt }).from(schema.apiToken).where(eq(schema.apiToken.id, auth.tokenId));
      let days = body.expiresInDays ?? null;
      // A leaked token must not outlive itself through the tokens it makes.
      if (self?.expiresAt) {
        const left = Math.floor((self.expiresAt.getTime() - Date.now()) / 86_400_000);
        if (left < 1) throw new ApiError(403, "This token expires within a day: make new tokens in the dashboard (Keys & tokens).");
        if (body.expiresInDays === undefined) days = left;
        else if (days === null || days > left)
          throw new ApiError(400, `This token expires in ${left} day${left === 1 ? "" : "s"}: a token it makes must expire within ${left} day${left === 1 ? "" : "s"} too.`);
      }
      const { token } = await unwrap(org.createApiToken({ name: body.name, scopes: body.scopes, projectIds: body.projectIds ?? null, expiresInDays: days }));
      const [row] = await db
        .select()
        .from(schema.apiToken)
        .where(and(eq(schema.apiToken.organizationId, auth.organizationId), eq(schema.apiToken.prefix, token.slice(0, 10))))
        .orderBy(desc(schema.apiToken.createdAt))
        .limit(1);
      return {
        token,
        id: row?.id ?? null,
        name: row?.name ?? body.name,
        granted: row?.scopes ?? null,
        projectIds: row?.projectIds ?? null,
        expiresAt: iso(row?.expiresAt),
      };
    },
  }),
  route({
    method: "DELETE",
    path: "/tokens/{tokenId}",
    tag: "Token",
    summary: "Revoke an API token",
    description: "A token can always revoke itself; other tokens need members.manage.",
    needs: [],
    handler: async ({ auth, params }) => {
      // A leaked token must not switch off its owner's other tokens (a CI deploy token, say).
      if (params.tokenId !== auth.tokenId && !auth.can("members.manage")) throw new ApiError(403, "This token can only revoke itself. Revoking other tokens needs members.manage.");
      return (await unwrap(org.revokeApiToken(params.tokenId))) ?? { ok: true };
    },
  }),

  // Activity
  route({
    method: "GET",
    path: "/activity",
    tag: "Organization",
    summary: "Activity log",
    description: "Newest first. Filter by projectId.",
    needs: ["projects.view"],
    query: z.object({ projectId: z.string().optional(), limit: z.coerce.number().int().optional(), offset: z.coerce.number().int().optional() }),
    handler: async ({ auth, query }) => {
      const { limit, offset } = page(query);
      const projectLimit = auth.projectIds ? or(isNull(schema.activity.projectId), ...auth.projectIds.map((id) => eq(schema.activity.projectId, id))) : undefined;
      const rows = await db
        .select({ activity: schema.activity, user: { id: schema.user.id, name: schema.user.name } })
        .from(schema.activity)
        .leftJoin(schema.user, eq(schema.activity.userId, schema.user.id))
        .where(and(eq(schema.activity.organizationId, auth.organizationId), query.projectId ? eq(schema.activity.projectId, query.projectId) : undefined, projectLimit))
        .orderBy(desc(schema.activity.createdAt))
        .limit(limit)
        .offset(offset);
      return {
        activity: rows.map(({ activity: a, user }) => ({
          id: a.id,
          action: a.action,
          message: a.message,
          targetType: a.targetType,
          targetId: a.targetId,
          projectId: a.projectId,
          user,
          createdAt: iso(a.createdAt),
        })),
      };
    },
  }),
];
