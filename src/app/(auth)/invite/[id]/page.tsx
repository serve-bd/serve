import Link from "next/link";
import { and, eq, gt } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getSession } from "@/server/auth";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/misc";
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
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Invite not valid</h1>
        <p className="text-[13px] leading-relaxed text-muted">
          This invite link was already used, revoked, or has expired. Ask an organization admin for a new link.
        </p>
        <Link href="/login" className={buttonVariants({ variant: "secondary" })}>
          Go to sign in
        </Link>
      </div>
    );
  }

  const session = await getSession();
  const [existing] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, row.invitation.email.toLowerCase()));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium tracking-wide text-accent uppercase">Invitation</p>
        <h1 className="text-2xl font-semibold">Join {row.org.name}</h1>
        <p className="text-[13px] leading-relaxed text-muted">
          {row.inviter.name} invited <span className="text-fg-2">{row.invitation.email}</span> to join as{" "}
          <span className="text-fg-2">{row.invitation.role ?? "member"}</span>.
        </p>
      </div>
      <Card className="p-5">
        <InviteActions
          invitationId={id}
          email={row.invitation.email}
          signedInAs={session?.user.email ?? null}
          hasAccount={!!existing}
        />
      </Card>
    </div>
  );
}
