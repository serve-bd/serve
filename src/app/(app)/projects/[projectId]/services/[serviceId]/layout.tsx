import { requireOrg } from "@/server/auth";
import { pageService } from "@/server/services/access";
import { serviceLive } from "@/server/service-data";
import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { serversForOrg } from "@/server/servers/access";
import { publishedPorts } from "@/server/services/ports";
import { ServiceHeader } from "./service-header";

export default async function ServiceLayout(props: LayoutProps<"/projects/[projectId]/services/[serviceId]">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service, project } = await pageService(serviceId, projectId, ctx.org.id);
  const [live, servers, [server]] = await Promise.all([
    serviceLive(serviceId),
    serversForOrg(ctx.org.id),
    db
      .select({ name: schema.server.name, host: schema.server.host, publicIp: schema.server.publicIp, isLocal: schema.server.isLocal })
      .from(schema.server)
      .where(eq(schema.server.id, service.serverId)),
  ]);
  const ports = await publishedPorts(service, server);
  // The server name is only worth showing when the organization can deploy to more than one.
  const [env] = await (await import("@/server/project-data")).projectEnvironments(projectId).then((envs) => envs.filter((e) => e.id === service.environmentId));
  return (
    <>
      <ServiceHeader
        project={{ id: project.id, name: project.name }}
        environment={env?.name ?? "production"}
        service={{
          id: service.id,
          name: service.name,
          type: service.type,
          icon: service.icon,
          engine: service.database?.engine ?? null,
          sourceType: service.source?.type ?? null,
          sourceLabel:
            service.source?.type === "git"
              ? `${service.source.repository.replace(/^https?:\/\/(www\.)?/, "").replace(/\.git$/, "")} · ${service.source.branch}`
              : service.source?.type === "image"
                ? service.source.image
                : service.database
                  ? `${service.database.engine} ${service.database.version}`
                  : service.compose?.template
                    ? `Template · ${service.compose.template}`
                    : "Docker Compose",
        }}
        initialLive={JSON.parse(JSON.stringify(live))}
        server={servers.length > 1 && server ? { id: service.serverId, name: server.name } : null}
        ports={ports.map((p) => ({ label: p.label, url: p.url, protocol: p.protocol }))}
        maintenance={service.type === "database" ? null : { enabled: !!service.maintenance?.enabled, since: service.maintenance?.since ?? null }}
      />
      {props.children}
    </>
  );
}
