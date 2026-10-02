import Link from "next/link";
import { and, eq, gt } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getSession } from "@/server/auth";
import { organizationRoles } from "@/server/permissions";
import { effectiveRoleId } from "@/lib/permissions";
import { buttonVariants } from "@/components/ui/button";
import { AuthCard } from "../../_components/auth-card";
import { InviteActions } from "./invite-actions";

export const metadata = { title: "Join organization" };

export default async function InvitePage(props: PageProps<"/invite/[id]">) {
  const { id } = await props.params;
  const [row] = await db
    .select({ invitation: schema.invitation, org: schema.organization, inviter: schema.user })
    .from(schema.invitation)
    .innerJoin(schema.organization, eq(schema.invitation.organizationId, schema.organization.id))
    .innerJoin(schema.user, eq(schema.invitation.inviterId, schema.user.id))
    .where(and(eq(schema.invitation.id, id), eq(schema.invitation.status, "pending"), gt(schema.invitation.expiresAt, new Date())));

  if (!row) {
    return (
      <AuthCard title="Invite not valid" description="This link was already used, revoked or has expired. Ask an organization admin for a new one.">
        <Link href="/login" className={buttonVariants({ variant: "secondary", size: "lg", className: "w-full" })}>
          Go to sign in
        </Link>
      </AuthCard>
    );
  }

  const session = await getSession();
  const [existing] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, row.invitation.email.toLowerCase()));
  // The stored role is only owner, admin or member: Developer, Viewer and custom roles are in roleId.
  const roleId = effectiveRoleId(row.invitation.role ?? "member", row.invitation.roleId);
  const roleName = (await organizationRoles(row.org.id)).find((r) => r.id === roleId)?.name ?? row.invitation.role ?? "member";

  return (
    <AuthCard
      eyebrow="Invitation"
      title={`Join ${row.org.name}`}
      description={
        <>
          {row.inviter.name} invited <span className="text-fg-2">{row.invitation.email}</span> as <span className="text-fg-2">{roleName}</span>.
        </>
      }
    >
      <InviteActions invitationId={id} email={row.invitation.email} signedInAs={session?.user.email ?? null} hasAccount={!!existing} />
    </AuthCard>
  );
}
