import { asc, eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { privateHost } from "@/lib/hostname";
import { pageService } from "@/server/services/access";
import { PageBody } from "@/components/shell/page-header";
import { ServiceOverview } from "./overview";
import { loadOverview } from "./overview-data";
import { DatabaseOverview } from "./database-overview";
import { engines } from "@/server/databases/engines";
import { databaseUrl } from "@/server/databases/options";
import { decryptOrNull } from "@/server/crypto";
import { publishedPorts } from "@/server/services/ports";
import { monitorSummary } from "@/server/monitoring/queries";
import { UptimeCard } from "./uptime-card";
import { loadPreviews } from "./previews/data";
import { PreviewsCard } from "./previews/previews-list";

export default async function ServicePage(props: PageProps<"/projects/[projectId]/services/[serviceId]">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);

  if (service.type === "database" && service.database) {
    const cfg = service.database;
    const engine = engines[cfg.engine];
    const [published] = await publishedPorts(service);
    // Roles without secret access get the shape of the URL, never the password.
    const hideSecrets = !ctx.can("variables.view-secrets");
    const creds = { username: cfg.username, password: hideSecrets ? "********" : (decryptOrNull(cfg.password) ?? ""), database: cfg.database };
    const monitoring = await monitorSummary(service.id);
    const branches = service.parentServiceId
      ? []
      : await db
          .select({ id: schema.databaseBranch.id, name: schema.databaseBranch.name, status: schema.databaseBranch.status, sizeBytes: schema.databaseBranch.sizeBytes })
          .from(schema.databaseBranch)
          .where(eq(schema.databaseBranch.serviceId, service.id))
          .orderBy(asc(schema.databaseBranch.createdAt));
    return (
      <PageBody className="flex flex-col gap-6">
        <DatabaseOverview
          serviceId={service.id}
          projectId={projectId}
          engine={{ label: engine.label, port: engine.port, hasUser: engine.hasUser, hasDatabase: engine.hasDatabase }}
          creds={creds}
          internalUrl={databaseUrl(cfg, creds, privateHost(service), engine.port)}
          publicUrl={published ? databaseUrl(cfg, creds, published.address, published.host) : null}
          host={privateHost(service)}
          publicPort={cfg.publicPort ?? null}
          publicBind={cfg.publicBind ?? "0.0.0.0"}
          publicAddress={published?.label ?? null}
          name={service.name}
          hideSecrets={hideSecrets}
          canManage={ctx.can("services.manage")}
          uptime={<UptimeCard summary={monitoring} settingsHref={`/projects/${projectId}/services/${service.id}/settings/monitoring`} />}
          uptimeInSide={!monitoring.monitor}
          branches={branches}
        />
      </PageBody>
    );
  }

  return (
    <PageBody>
      <ServiceOverview
        {...(await loadOverview(service, projectId, ctx.org.id))}
        previewsCard={
          service.type === "app" && service.source?.type === "git" && !service.parentServiceId && service.previewsEnabled ? (
            <PreviewsCard key="previews" projectId={projectId} serviceId={service.id} previews={await loadPreviews(service.id)} />
          ) : null
        }
      />
    </PageBody>
  );
}
