import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { db, schema } from "@/server/db";
import { eq } from "drizzle-orm";
import { Logo } from "@/components/brand";
import { NoOrgActions } from "./actions";

export const metadata = { title: "No organization" };

export default async function NoOrganizationPage() {
  const user = await requireUser();
  const [m] = await db.select({ id: schema.member.id }).from(schema.member).where(eq(schema.member.userId, user.id)).limit(1);
  if (m) redirect("/");
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center">
      <Logo />
      <div className="flex max-w-sm flex-col gap-2">
        <h1 className="text-2xl font-semibold">You&apos;re not in an organization</h1>
        <p className="text-[13px] leading-relaxed text-muted">Ask an admin for an invite link, or create an organization if this server allows it.</p>
      </div>
      <NoOrgActions />
    </div>
  );
}
