import { PageBody, PageHeader } from "@/components/shell/page-header";
import { NewProjectForm } from "./form";

export const metadata = { title: "New project" };

export default function NewProjectPage() {
  return (
    <>
      <PageHeader title="New project" breadcrumbs={[{ label: "Projects", href: "/projects" }, { label: "New" }]} />
      <PageBody className="max-w-2xl">
        <NewProjectForm />
      </PageBody>
    </>
  );
}
