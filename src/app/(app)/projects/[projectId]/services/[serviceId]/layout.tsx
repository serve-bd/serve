import { requireOrg } from "@/server/auth";
import { pageService } from "@/server/services/access";
import { serviceLive } from "@/server/service-data";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { serversForOrg } from "@/server/servers/access";
import { publishedPorts } from "@/server/services/ports";
import { serviceIssues } from "@/server/services/issues";
import { ServiceHeader } from "./service-header";

export default async function ServiceLayout(props: LayoutProps<"/projects/[projectId]/services/[serviceId]">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service, project } = await pageService(serviceId, projectId, ctx.org.id);
  const [live, servers, [server], issues] = await Promise.all([
    serviceLive(serviceId),
    serversForOrg(ctx.org.id),
    db
      .select({ name: schema.server.name, host: schema.server.host, publicIp: schema.server.publicIp, isLocal: schema.server.isLocal })
      .from(schema.server)
      .where(eq(schema.server.id, service.serverId)),
    serviceIssues([serviceId]),
  ]);
  // The other services of this environment, for the switcher in the breadcrumb (previews stay out).
  const siblings = await db
    .select({
      id: schema.service.id,
      name: schema.service.name,
      type: schema.service.type,
      icon: schema.service.icon,
      status: schema.service.status,
      database: schema.service.database,
      source: schema.service.source,
    })
    .from(schema.service)
    .where(and(eq(schema.service.projectId, projectId), eq(schema.service.environmentId, service.environmentId), isNull(schema.service.parentServiceId)))
    .orderBy(asc(schema.service.name));
  // Pull request previews live on the app's Previews tab; a preview links back to its app.
  const [previews, [parent]] = await Promise.all([
    db
      .select({ id: schema.service.id })
      .from(schema.service)
      .where(and(eq(schema.service.parentServiceId, service.id), eq(schema.service.type, "app"), isNotNull(schema.service.previewPr))),
    service.parentServiceId && service.previewPr !== null
      ? db.select({ id: schema.service.id, name: schema.service.name }).from(schema.service).where(eq(schema.service.id, service.parentServiceId))
      : Promise.resolve([]),
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
          environmentId: service.environmentId,
          isPreview: !!service.parentServiceId,
          previews: service.type === "app" && service.source?.type === "git" && !service.parentServiceId && (service.previewsEnabled || previews.length) ? previews.length : null,
          parent: parent && service.previewPr !== null ? { id: parent.id, name: parent.name, pr: service.previewPr } : null,
          icon: service.icon,
          engine: service.database?.engine ?? null,
          sourceType: service.source?.type ?? null,
          sourceLabel:
            service.source?.type === "git"
              ? `${service.source.repository.replace(/^https?:\/\/(www\.)?/, "").replace(/\.git$/, "")} · ${service.source.branch}`
              : service.source?.type === "image"
                ? service.source.image
                : service.source?.type === "dockerfile"
                  ? "Dockerfile"
                  : service.database
                    ? `${service.database.engine} ${service.database.version}`
                    : // Compose stacks: the icon and name already say what it is.
                      "",
        }}
        initialLive={JSON.parse(JSON.stringify(live))}
        server={servers.length > 1 && server ? { id: service.serverId, name: server.name } : null}
        ports={ports.map((p) => ({ label: p.label, url: p.url, protocol: p.protocol }))}
        issues={issues.get(serviceId) ?? []}
        siblings={siblings.map((s) => ({
          id: s.id,
          name: s.name,
          type: s.type,
          icon: s.icon,
          status: s.status,
          engine: s.database?.engine ?? null,
          sourceType: s.source?.type ?? null,
        }))}
        maintenance={service.type === "database" ? null : { enabled: !!service.maintenance?.enabled, since: service.maintenance?.since ?? null }}
      />
      {props.children}
    </>
  );
}
