import { requireOrg } from "@/server/auth";
import { pageService } from "@/server/services/access";
import { PageBody } from "@/components/shell/page-header";
import { ServiceOverview } from "./overview";
import { loadOverview } from "./overview-data";
import { DatabaseOverview } from "./database-overview";
import { engines } from "@/server/databases/engines";
import { databaseUrl } from "@/server/databases/options";
import { decryptOrNull } from "@/server/crypto";
import { publishedPorts } from "@/server/services/ports";

export default async function ServicePage(props: PageProps<"/projects/[projectId]/services/[serviceId]">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);

  if (service.type === "database" && service.database) {
    const cfg = service.database;
    const engine = engines[cfg.engine];
    const [published] = await publishedPorts(service);
    const creds = { username: cfg.username, password: decryptOrNull(cfg.password) ?? "", database: cfg.database };
    return (
      <PageBody>
        <DatabaseOverview
          serviceId={service.id}
          projectId={projectId}
          engine={{ label: engine.label, port: engine.port, hasUser: engine.hasUser, hasDatabase: engine.hasDatabase }}
          creds={creds}
          internalUrl={databaseUrl(cfg, creds, service.slug, engine.port)}
          publicUrl={published ? databaseUrl(cfg, creds, published.address, published.host) : null}
          host={service.slug}
          publicPort={cfg.publicPort ?? null}
          publicBind={cfg.publicBind ?? "0.0.0.0"}
          publicAddress={published?.label ?? null}
          name={service.name}
        />
      </PageBody>
    );
  }

  return (
    <PageBody>
      <ServiceOverview {...await loadOverview(service, projectId, ctx.org.id)} />
    </PageBody>
  );
}
