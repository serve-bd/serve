import { redirect } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { TemplateEditor } from "../template-editor";
import { editorCategories, newTemplateInitial } from "../editor-data";

export const metadata = { title: "New template" };

export default async function NewTemplatePage(props: PageProps<"/templates/new">) {
  const ctx = await requireOrg();
  if (!ctx.can("integrations.manage")) redirect("/templates");
  const { from, service } = await props.searchParams;
  const initial = await newTemplateInitial(ctx.org.id, typeof from === "string" ? from : undefined, typeof service === "string" ? service : undefined);
  return (
    <>
      <PageHeader
        title="New template"
        description="Save a compose file once and create it from any project in one click."
        breadcrumbs={[{ label: "Templates", href: "/templates" }, { label: "New template" }]}
      />
      <PageBody>
        <TemplateEditor initial={initial} categories={editorCategories} />
      </PageBody>
    </>
  );
}
