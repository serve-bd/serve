import { PageBody, PageHeader } from "@/components/shell/page-header";
import { NewProjectForm } from "./form";
import { NoAccess } from "@/components/no-access";
import { requireOrg } from "@/server/auth";

export const metadata = { title: "New project" };

export default async function NewProjectPage() {
  const ctx = await requireOrg();
  if (!ctx.can("projects.manage"))
    return (
      <>
        <PageHeader title="New project" breadcrumbs={[{ label: "Projects", href: "/projects" }, { label: "New" }]} />
        <NoAccess permission="projects.manage" />
      </>
    );
  return (
    <>
      <PageHeader title="New project" breadcrumbs={[{ label: "Projects", href: "/projects" }, { label: "New" }]} />
      <PageBody className="max-w-2xl">
        <NewProjectForm />
      </PageBody>
    </>
  );
}
