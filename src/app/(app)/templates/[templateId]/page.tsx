import { notFound, redirect } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { TemplateEditor } from "../template-editor";
import { editorCategories, existingTemplateInitial } from "../editor-data";

export const metadata = { title: "Edit template" };

export default async function EditTemplatePage(props: PageProps<"/templates/[templateId]">) {
  const ctx = await requireOrg();
  if (!ctx.isAdmin) redirect("/templates");
  const { templateId } = await props.params;
  const initial = await existingTemplateInitial(ctx.org.id, templateId);
  if (!initial) notFound();
  return (
    <>
      <PageHeader
        title={initial.name}
        description="Changes apply to services created from now on."
        breadcrumbs={[{ label: "Templates", href: "/templates" }, { label: initial.name }]}
      />
      <PageBody>
        <TemplateEditor initial={initial} categories={editorCategories} />
      </PageBody>
    </>
  );
}
