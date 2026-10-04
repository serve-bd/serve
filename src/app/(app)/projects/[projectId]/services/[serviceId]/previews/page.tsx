import { redirect } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { pageService } from "@/server/services/access";
import { PageBody } from "@/components/shell/page-header";
import { loadPreviews } from "./data";
import { PreviewsList } from "./previews-list";

export const metadata = { title: "Previews" };

export default async function PreviewsPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/previews">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  const source = service.source;
  if (service.type !== "app" || (source?.type !== "git" && source?.type !== "image") || service.parentServiceId) redirect(`/projects/${projectId}/services/${serviceId}`);
  return (
    <PageBody>
      <PreviewsList
        projectId={projectId}
        serviceId={service.id}
        enabled={service.previewsEnabled}
        image={source.type === "image" ? source.image : null}
        previewDomain={service.previewDomain}
        canManage={ctx.can("services.manage")}
        canDeploy={ctx.can("services.deploy")}
        previews={await loadPreviews(service.id)}
      />
    </PageBody>
  );
}
