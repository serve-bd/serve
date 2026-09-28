import { requireOrg } from "@/server/auth";
import { pageService } from "@/server/services/access";
import { serviceLive } from "@/server/service-data";
import { ServiceHeader } from "./service-header";

export default async function ServiceLayout(props: LayoutProps<"/projects/[projectId]/services/[serviceId]">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service, project } = await pageService(serviceId, projectId, ctx.org.id);
  const live = await serviceLive(serviceId);
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
      />
      {props.children}
    </>
  );
}
