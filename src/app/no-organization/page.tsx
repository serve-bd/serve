import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { db, schema } from "@/server/db";
import { eq } from "drizzle-orm";
import { Logo } from "@/components/brand";
import { getSetting } from "@/server/settings";
import { isInstanceAdmin } from "@/server/auth";
import { NoOrgActions } from "./actions";

export const metadata = { title: "No organization" };

export default async function NoOrganizationPage() {
  const user = await requireUser();
  const [m] = await db.select({ id: schema.member.id }).from(schema.member).where(eq(schema.member.userId, user.id)).limit(1);
  if (m) redirect("/");
  const canCreate = (await getSetting("allowOrganizationCreation")) || (await isInstanceAdmin(user.id));
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center">
      <Logo />
      <div className="flex max-w-sm flex-col gap-2">
        <h1 className="text-2xl font-semibold">You&apos;re not in an organization</h1>
        <p className="text-[13px] leading-relaxed text-muted">
          {canCreate ? "Ask an admin for an invite link, or create your own organization." : "Ask an admin of this server to invite you. Your invite link brings you straight in."}
        </p>
      </div>
      <NoOrgActions canCreate={canCreate} />
    </div>
  );
}
