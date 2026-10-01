import { and, asc, eq, gt } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { isEmailConfigured } from "@/server/email/send";
import { publicBaseUrl } from "@/server/git/github-app";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { effectiveRoleId } from "@/lib/permissions";
import { organizationRoles } from "@/server/permissions";
import { MembersView } from "./members-view";

export const metadata = { title: "Members" };

export default async function MembersPage() {
  const ctx = await requireOrg();
  const [members, invitations, roles, projects] = await Promise.all([
    db
      .select({
        id: schema.member.id,
        role: schema.member.role,
        roleId: schema.member.roleId,
        projectIds: schema.member.projectIds,
        createdAt: schema.member.createdAt,
        userId: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        image: schema.user.image,
      })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
      .where(eq(schema.member.organizationId, ctx.org.id))
      .orderBy(asc(schema.member.createdAt)),
    // Invite links are credentials: only roles that manage members see them.
    ctx.can("members.manage")
      ? db
          .select()
          .from(schema.invitation)
          .where(and(eq(schema.invitation.organizationId, ctx.org.id), eq(schema.invitation.status, "pending"), gt(schema.invitation.expiresAt, new Date())))
          .orderBy(asc(schema.invitation.createdAt))
      : Promise.resolve([]),
    organizationRoles(ctx.org.id),
    db.select({ id: schema.project.id, name: schema.project.name }).from(schema.project).where(eq(schema.project.organizationId, ctx.org.id)).orderBy(asc(schema.project.name)),
  ]);
  return (
    <>
      <PageHeader title="Members" description={`People with access to ${ctx.org.name}.`} />
      <PageBody>
        <MembersView
          baseUrl={await publicBaseUrl()}
          emailEnabled={await isEmailConfigured()}
          canResetPasswords={ctx.isInstanceAdmin}
          addsDirectly={ctx.isInstanceAdmin}
          me={ctx.user.id}
          myRoleId={ctx.roleId}
          myPermissions={[...ctx.permissions]}
          canManage={ctx.can("members.manage")}
          roles={roles}
          // A member limited to some projects only hands out those.
          projects={projects.filter((p) => ctx.canAccessProject(p.id))}
          members={members.map((m) => ({
            ...m,
            roleId: effectiveRoleId(m.role, m.roleId),
            projectIds: m.role === "member" && m.projectIds?.length ? m.projectIds : null,
            createdAt: m.createdAt.toISOString(),
          }))}
          invitations={invitations.map((i) => ({ id: i.id, email: i.email, roleId: effectiveRoleId(i.role ?? "member", i.roleId), expiresAt: i.expiresAt.toISOString() }))}
        />
      </PageBody>
    </>
  );
}
