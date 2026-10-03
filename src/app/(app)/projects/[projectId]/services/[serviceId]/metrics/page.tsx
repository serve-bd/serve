import { requireOrg } from "@/server/auth";
import { pageService } from "@/server/services/access";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { PageBody } from "@/components/shell/page-header";
import { ServiceMetrics } from "./service-metrics";

export const metadata = { title: "Metrics" };

export default async function MetricsPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/metrics">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  const [[server], domains] = await Promise.all([
    db.select({ metricsEnabled: schema.server.metricsEnabled }).from(schema.server).where(eq(schema.server.id, service.serverId)),
    db.select({ id: schema.domain.id }).from(schema.domain).where(eq(schema.domain.serviceId, service.id)).limit(1),
  ]);
  const resources = server?.metricsEnabled ?? true;
  // Request counts come from the proxy: without a domain there are none to show.
  const hasDomains = service.type !== "database" && domains.length > 0;
  // Nothing to show: no metrics and no request counts (the tab is hidden too).
  if (!resources && !hasDomains) notFound();
  return (
    <PageBody>
      <ServiceMetrics serviceId={service.id} memoryLimit={service.runtime.memoryLimit ?? null} hasDomains={hasDomains} resources={resources} />
    </PageBody>
  );
}
