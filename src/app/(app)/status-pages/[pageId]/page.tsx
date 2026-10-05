import { notFound } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { editorData } from "@/server/status-pages/admin";
import { poweredBy } from "@/server/status-pages/public";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/misc";
import { visibilityBadge } from "../badges";
import { StatusPageEditor } from "./editor";

export async function generateMetadata(props: PageProps<"/status-pages/[pageId]">) {
  const { pageId } = await props.params;
  const ctx = await requireOrg();
  const data = await editorData(pageId, ctx.org.id);
  return { title: data ? data.page.name : "Status page" };
}

export default async function StatusPageEditorPage(props: PageProps<"/status-pages/[pageId]">) {
  const { pageId } = await props.params;
  const { tab } = await props.searchParams;
  const ctx = await requireOrg();
  const data = await editorData(pageId, ctx.org.id);
  if (!data) notFound();
  const canManage = ctx.can("status-pages.manage") && !ctx.projectIds;
  const badge = visibilityBadge[data.page.visibility];
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            {data.page.name} <Badge tone={badge.tone}>{badge.label}</Badge>
          </span>
        }
        breadcrumbs={[{ label: "Status pages", href: "/status-pages" }, { label: data.page.name }]}
      />
      <PageBody>
        <StatusPageEditor data={data} canManage={canManage} poweredBy={await poweredBy()} tab={typeof tab === "string" ? tab : undefined} />
      </PageBody>
    </>
  );
}
