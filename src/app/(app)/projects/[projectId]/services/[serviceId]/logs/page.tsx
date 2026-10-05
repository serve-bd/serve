import { poolerEnabled, replicaInstances } from "@/server/services/types";
import { NoAccess } from "@/components/no-access";
import { requireOrg } from "@/server/auth";
import { pageService } from "@/server/services/access";
import { PageBody } from "@/components/shell/page-header";
import { composeServiceNames } from "@/server/deploy/compose";
import { inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { runServerIds } from "@/server/deploy/distribution";
import { RuntimeLogs } from "./runtime-logs";

export const metadata = { title: "Logs" };

export default async function LogsPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/logs">) {
  const { projectId, serviceId } = await props.params;
  const { container } = await props.searchParams;
  const ctx = await requireOrg();
  if (!ctx.can("logs.view")) return <NoAccess permission="logs.view" />;
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  // A database with a pooler (PostgreSQL) or read replicas: a tab for each, the database's own first.
  const replicas = replicaInstances(service);
  const addonLabels =
    service.type === "database" && (poolerEnabled(service) || replicas.length)
      ? {
          database: "Database",
          ...(poolerEnabled(service) ? { pooler: "Pooler" } : {}),
          ...Object.fromEntries(replicas.map((r) => [`replica-${r.id}`, `Replica ${r.id}`])),
        }
      : null;
  // An app on several servers: a tab per replica of each server, its server first in the name.
  const runOn = service.type === "app" ? runServerIds(service.serverId, service.distribution) : [];
  const perServer = Math.max(1, Math.min(service.runtime.replicas || 1, 20));
  const servers = runOn.length > 1 ? await db.select({ id: schema.server.id, name: schema.server.name }).from(schema.server).where(inArray(schema.server.id, runOn)) : [];
  const serverLabels =
    servers.length > 1
      ? Object.fromEntries(
          runOn.flatMap((id) => {
            const name = servers.find((x) => x.id === id)?.name ?? id;
            return Array.from({ length: perServer }, (_, i) => [`${id}:${i + 1}`, `${name} · Replica ${i + 1}`]);
          }),
        )
      : null;
  return (
    <PageBody>
      <RuntimeLogs
        serviceId={service.id}
        name={service.slug}
        containers={
          addonLabels
            ? Object.keys(addonLabels)
            : serverLabels
              ? Object.keys(serverLabels)
              : service.type === "compose"
                ? composeServiceNames(service.compose?.content ?? "")
                : // Replicas on this server, numbered like their containers (<slug>-<deployment>-<n>).
                  Array.from({ length: service.type === "app" ? Math.max(1, Math.min(service.runtime.replicas || 1, 20)) : 1 }, (_, i) => String(i + 1))
        }
        replicas={service.type === "app"}
        labels={addonLabels ?? serverLabels ?? undefined}
        initialContainer={typeof container === "string" ? container : null}
      />
    </PageBody>
  );
}
