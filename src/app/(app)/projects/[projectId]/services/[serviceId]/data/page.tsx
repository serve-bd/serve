import { notFound } from "next/navigation";
import { NoAccess } from "@/components/no-access";
import { requireOrg } from "@/server/auth";
import { pageService } from "@/server/services/access";
import { explorerOverview } from "@/server/actions/database-explorer";
import { PageBody } from "@/components/shell/page-header";
import { DataBrowser } from "./data-view";

export const metadata = { title: "Data" };

export default async function DataPage(props: { params: Promise<{ projectId: string; serviceId: string }> }) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  // Reading the data is like opening a shell on the database.
  if (!ctx.can("console.access")) return <NoAccess permission="console.access" />;
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  if (service.type !== "database" || !service.database) notFound();
  const running = service.status === "running";
  // The tables live inside the database: they are read from it on every visit.
  const res = running ? await explorerOverview(service.id) : null;
  return (
    <PageBody>
      <DataBrowser
        serviceId={service.id}
        serviceName={service.name}
        engine={service.database.engine}
        running={running}
        error={res && !res.ok ? res.error : null}
        initial={res?.ok ? res.data : null}
      />
    </PageBody>
  );
}
