import { poolerEnabled, replicaInstances } from "@/server/services/types";
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
  // A PostgreSQL database with a pooler or replicas: a tab for each, the database's own first.
  const replicas = replicaInstances(service);
  const addonLabels =
    service.type === "database" && (poolerEnabled(service) || replicas.length)
      ? {
          database: "Database",
          ...(poolerEnabled(service) ? { pooler: "Pooler" } : {}),
          ...Object.fromEntries(replicas.map((r) => [`replica-${r.id}`, `Replica ${r.id}`])),
        }
      : null;
  return (
    <PageBody>
      <RuntimeLogs
        serviceId={service.id}
        name={service.slug}
        containers={
          addonLabels
            ? Object.keys(addonLabels)
            : service.type === "compose"
              ? composeServiceNames(service.compose?.content ?? "")
              : // Replicas on this server, numbered like their containers (<slug>-<deployment>-<n>).
                Array.from({ length: service.type === "app" ? Math.max(1, Math.min(service.runtime.replicas || 1, 20)) : 1 }, (_, i) => String(i + 1))
        }
        replicas={service.type === "app"}
        labels={addonLabels ?? undefined}
        initialContainer={typeof container === "string" ? container : null}
      />
    </PageBody>
  );
}
