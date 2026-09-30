import { notFound } from "next/navigation";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { instanceAdminPage } from "@/server/auth";
import { db, schema } from "@/server/db";
import { effectiveLimits, orgUsage } from "@/server/limits";
import { organizationRoles } from "@/server/permissions";
import { getSettings } from "@/server/settings";
import { effectiveRoleId } from "@/lib/permissions";
import { OrgDetails } from "./org-details";

export const metadata = { title: "Organization" };

export default async function OrganizationDetailsPage({ params }: PageProps<"/settings/organizations/[orgId]">) {
  const ctx = await instanceAdminPage();
  const { orgId } = await params;
  const [org] = await db
    .select({ id: schema.organization.id, name: schema.organization.name, createdAt: schema.organization.createdAt })
    .from(schema.organization)
    .where(eq(schema.organization.id, orgId));
  if (!org) notFound();
  const [settings, members, roles, users, invitations, limitRow, servers] = await Promise.all([
    getSettings(),
    db
      .select({
        id: schema.member.id,
        role: schema.member.role,
        roleId: schema.member.roleId,
        createdAt: schema.member.createdAt,
        userId: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        image: schema.user.image,
      })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
      .where(eq(schema.member.organizationId, org.id))
      .orderBy(asc(schema.member.createdAt)),
    organizationRoles(org.id),
    db
      .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
      .from(schema.user)
      .where(sql`not exists (select 1 from member m where m.user_id = ${schema.user.id} and m.organization_id = ${org.id})`)
      .orderBy(asc(schema.user.name)),
    db
      .select({ id: schema.invitation.id, email: schema.invitation.email, role: schema.invitation.role, roleId: schema.invitation.roleId, expiresAt: schema.invitation.expiresAt })
      .from(schema.invitation)
      .where(and(eq(schema.invitation.organizationId, org.id), eq(schema.invitation.status, "pending"), gt(schema.invitation.expiresAt, new Date())))
      .orderBy(asc(schema.invitation.createdAt)),
    db.select({ custom: schema.organizationLimit.custom }).from(schema.organizationLimit).where(eq(schema.organizationLimit.organizationId, org.id)),
    db.select({ id: schema.server.id, name: schema.server.name }).from(schema.server).orderBy(asc(schema.server.createdAt)),
  ]);
  const root = org.id === settings.rootOrganizationId;
  const limits = await effectiveLimits(org.id);
  const usage = await orgUsage(org.id, limits);
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? "Viewer";
  return (
    <OrgDetails
      org={{ id: org.id, name: org.name, members: members.length, root, custom: !!limitRow[0]?.custom, limits, usage }}
      createdAt={org.createdAt.toISOString()}
      // The Root organization's members change here only for its owners; admins use Organization → Members.
      canEdit={!root || ctx.role === "owner"}
      me={ctx.user.id}
      roles={roles.map((r) => ({ id: r.id, name: r.name, description: r.description }))}
      members={members.map((m) => ({ ...m, roleId: effectiveRoleId(m.role, m.roleId), createdAt: m.createdAt.toISOString() }))}
      users={users}
      invitations={invitations.map((i) => ({ id: i.id, email: i.email, role: roleName(effectiveRoleId(i.role ?? "member", i.roleId)), expiresAt: i.expiresAt.toISOString() }))}
      servers={servers}
    />
  );
}
