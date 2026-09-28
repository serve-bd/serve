import { requireOrg } from "@/server/auth";
import { pageService } from "@/server/services/access";
import { composeServiceNames } from "@/server/deploy/compose";
import { PageBody } from "@/components/shell/page-header";
import { TasksView } from "./tasks-view";

export const metadata = { title: "Scheduled tasks" };

export default async function TasksPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/tasks">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  return (
    <PageBody>
      <TasksView serviceId={service.id} composeServices={service.type === "compose" ? composeServiceNames(service.compose?.content ?? "") : []} />
    </PageBody>
  );
}
