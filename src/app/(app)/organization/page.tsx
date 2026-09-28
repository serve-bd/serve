import { requireOrg } from "@/server/auth";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { OrgSettings } from "./org-settings";

export const metadata = { title: "Organization" };

export default async function OrganizationPage() {
  const ctx = await requireOrg();
  return (
    <>
      <PageHeader title="Organization" description="Settings for this organization." />
      <PageBody className="max-w-3xl">
        <OrgSettings org={{ id: ctx.org.id, name: ctx.org.name, slug: ctx.org.slug }} role={ctx.role} isRoot={ctx.isRoot} />
      </PageBody>
    </>
  );
}
