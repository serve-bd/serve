import { requireOrg } from "@/server/auth";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { AccountView } from "./account-view";

export const metadata = { title: "Account" };

export default async function AccountPage() {
  const ctx = await requireOrg();
  return (
    <>
      <PageHeader title="Account" description="Your profile, password and signed-in devices." />
      <PageBody className="max-w-3xl">
        <AccountView user={{ name: ctx.user.name, email: ctx.user.email }} />
      </PageBody>
    </>
  );
}
