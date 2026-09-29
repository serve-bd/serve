import { requireOrg } from "@/server/auth";
import { pageService } from "@/server/services/access";
import { PageBody } from "@/components/shell/page-header";
import { DeploymentsList } from "../deployments-list";

export const metadata = { title: "Deployments" };

export default async function DeploymentsPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/deployments">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  return (
    <PageBody>
      <DeploymentsList serviceId={service.id} projectId={projectId} type={service.type} />
    </PageBody>
  );
}
