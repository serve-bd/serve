import { NoAccess } from "@/components/no-access";
import { requireOrg } from "@/server/auth";
import { pageService } from "@/server/services/access";
import { PageBody } from "@/components/shell/page-header";
import { composeServiceNames } from "@/server/deploy/compose";
import { RuntimeLogs } from "./runtime-logs";

export const metadata = { title: "Logs" };

export default async function LogsPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/logs">) {
  const { projectId, serviceId } = await props.params;
  const { container } = await props.searchParams;
  const ctx = await requireOrg();
  if (!ctx.can("logs.view")) return <NoAccess permission="logs.view" />;
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  return (
    <PageBody>
      <RuntimeLogs
        serviceId={service.id}
        name={service.slug}
        containers={service.type === "compose" ? composeServiceNames(service.compose?.content ?? "") : []}
        initialContainer={typeof container === "string" ? container : null}
      />
    </PageBody>
  );
}
