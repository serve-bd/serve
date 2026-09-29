import { eq, sql } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { effectiveRoleId } from "@/lib/permissions";
import { organizationRoles } from "@/server/permissions";
import { RolesView } from "./roles-view";

export const metadata = { title: "Roles" };

export default async function RolesPage() {
  const ctx = await requireOrg();
  const [roles, members] = await Promise.all([
    organizationRoles(ctx.org.id),
    db
      .select({ role: schema.member.role, roleId: schema.member.roleId, n: sql<number>`count(*)::int` })
      .from(schema.member)
      .where(eq(schema.member.organizationId, ctx.org.id))
      .groupBy(schema.member.role, schema.member.roleId),
  ]);
  const counts = new Map<string, number>();
  for (const m of members) {
    const id = effectiveRoleId(m.role, m.roleId);
    counts.set(id, (counts.get(id) ?? 0) + m.n);
  }
  return (
    <>
      <PageHeader
        title="Roles"
        breadcrumbs={[{ label: "Members", href: "/organization/members" }, { label: "Roles" }]}
        description="What each role can do in this organization. Owners and admins can do everything."
      />
      <PageBody>
        <RolesView roles={roles.map((r) => ({ ...r, members: counts.get(r.id) ?? 0 }))} canEdit={ctx.isAdmin} />
      </PageBody>
    </>
  );
}
