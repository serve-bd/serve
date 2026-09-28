import { and, asc, eq, gt } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { env } from "@/server/env";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { MembersView } from "./members-view";

export const metadata = { title: "Members" };

export default async function MembersPage() {
  const ctx = await requireOrg();
  const [members, invitations] = await Promise.all([
    db
      .select({ id: schema.member.id, role: schema.member.role, createdAt: schema.member.createdAt, userId: schema.user.id, name: schema.user.name, email: schema.user.email, image: schema.user.image })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
      .where(eq(schema.member.organizationId, ctx.org.id))
      .orderBy(asc(schema.member.createdAt)),
    db
      .select()
      .from(schema.invitation)
      .where(and(eq(schema.invitation.organizationId, ctx.org.id), eq(schema.invitation.status, "pending"), gt(schema.invitation.expiresAt, new Date())))
      .orderBy(asc(schema.invitation.createdAt)),
  ]);
  return (
    <>
      <PageHeader title="Members" description={`People with access to ${ctx.org.name}.`} />
      <PageBody className="max-w-4xl">
        <MembersView
          baseUrl={env.appUrl.replace(/\/$/, "")}
          me={ctx.user.id}
          myRole={ctx.role}
          members={members.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() }))}
          invitations={invitations.map((i) => ({ id: i.id, email: i.email, role: i.role ?? "member", expiresAt: i.expiresAt.toISOString() }))}
        />
      </PageBody>
    </>
  );
}
