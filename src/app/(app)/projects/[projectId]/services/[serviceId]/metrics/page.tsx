import { requireOrg } from "@/server/auth";
import { pageService } from "@/server/services/access";
import { PageBody } from "@/components/shell/page-header";
import { ServiceMetrics } from "./service-metrics";

export const metadata = { title: "Metrics" };

export default async function MetricsPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/metrics">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  return (
    <PageBody>
      <ServiceMetrics serviceId={service.id} memoryLimit={service.runtime.memoryLimit ?? null} />
    </PageBody>
  );
}
