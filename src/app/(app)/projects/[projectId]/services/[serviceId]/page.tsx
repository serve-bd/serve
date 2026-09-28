import { requireOrg } from "@/server/auth";
import { pageService } from "@/server/services/access";
import { PageBody } from "@/components/shell/page-header";
import { DeploymentsList } from "./deployments-list";
import { DatabaseOverview } from "./database-overview";
import { engines } from "@/server/databases/engines";
import { decryptOrNull } from "@/server/crypto";
import { getSettings } from "@/server/settings";

export default async function ServicePage(props: PageProps<"/projects/[projectId]/services/[serviceId]">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);

  if (service.type === "database" && service.database) {
    const cfg = service.database;
    const engine = engines[cfg.engine];
    const settings = await getSettings();
    const creds = { username: cfg.username, password: decryptOrNull(cfg.password) ?? "", database: cfg.database };
    return (
      <PageBody>
        <DatabaseOverview
          serviceId={service.id}
          projectId={projectId}
          engine={{ label: engine.label, port: engine.port, hasUser: engine.hasUser, hasDatabase: engine.hasDatabase }}
          creds={creds}
          internalUrl={engine.url({ ...creds, host: service.slug, port: engine.port })}
          publicUrl={cfg.publicPort && settings.serverIp ? engine.url({ ...creds, host: settings.serverIp, port: cfg.publicPort }) : null}
          host={service.slug}
          publicPort={cfg.publicPort ?? null}
          serverIp={settings.serverIp}
          name={service.name}
        />
      </PageBody>
    );
  }

  return (
    <PageBody>
      <DeploymentsList serviceId={service.id} projectId={projectId} type={service.type} />
    </PageBody>
  );
}
