import { requireOrg } from "@/server/auth";
import { pageService } from "@/server/services/access";
import { PageBody } from "@/components/shell/page-header";
import { RuntimeLogs } from "./runtime-logs";

export const metadata = { title: "Logs" };

export default async function LogsPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/logs">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  return (
    <PageBody>
      <RuntimeLogs serviceId={service.id} name={service.slug} />
    </PageBody>
  );
}
