import { asc, sql } from "drizzle-orm";
import { instanceAdminPage } from "@/server/auth";
import { db, schema } from "@/server/db";
import { organizationRoles } from "@/server/permissions";
import { getSetting } from "@/server/settings";
import { effectiveRoleId } from "@/lib/permissions";
import { UsersView } from "./users-view";

export const metadata = { title: "Users" };

export default async function UsersPage() {
  const ctx = await instanceAdminPage();
  const [users, memberships, orgs, rootId] = await Promise.all([
    db
      .select({
        id: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        image: schema.user.image,
        twoFactor: schema.user.twoFactorEnabled,
        createdAt: schema.user.createdAt,
        methods: sql<string[]>`coalesce((select array_agg(distinct a.provider_id) from account a where a.user_id = "user"."id"), '{}')`,
        lastActive: sql<string | null>`(select max(s.updated_at) from session s where s.user_id = "user"."id")`,
      })
      .from(schema.user)
      .orderBy(asc(schema.user.createdAt)),
    db.select({ userId: schema.member.userId, organizationId: schema.member.organizationId, role: schema.member.role, roleId: schema.member.roleId }).from(schema.member),
    db.select({ id: schema.organization.id, name: schema.organization.name }).from(schema.organization).orderBy(asc(schema.organization.createdAt)),
    getSetting("rootOrganizationId"),
  ]);
  const roles = Object.fromEntries(
    await Promise.all(orgs.map(async (o) => [o.id, (await organizationRoles(o.id)).map((r) => ({ id: r.id, name: r.name, description: r.description }))] as const)),
  );
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  return (
    <UsersView
      me={ctx.user.id}
      // Root members change only through its owners (or Organization → Members).
      orgs={orgs.filter((o) => o.id !== rootId || ctx.role === "owner").map((o) => ({ ...o, root: o.id === rootId }))}
      roles={roles}
      users={users.map((u) => ({
        ...u,
        createdAt: u.createdAt.toISOString(),
        lastActive: u.lastActive ? new Date(u.lastActive).toISOString() : null,
        memberships: memberships
          .filter((m) => m.userId === u.id)
          .map((m) => {
            const roleId = effectiveRoleId(m.role, m.roleId);
            return {
              organizationId: m.organizationId,
              name: orgName.get(m.organizationId) ?? "?",
              root: m.organizationId === rootId,
              role: roles[m.organizationId]?.find((r) => r.id === roleId)?.name ?? "Viewer",
            };
          }),
      }))}
    />
  );
}
