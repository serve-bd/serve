import { cookies } from "next/headers";
import { requireOrg } from "@/server/auth";
import { pageProject } from "@/server/services/access";
import { environmentServices, resolveEnvironment } from "@/server/project-data";
import { environmentKept } from "@/server/services/kept-data";
import { ProjectView } from "./project-view";

export async function generateMetadata(props: PageProps<"/projects/[projectId]">) {
  const { projectId } = await props.params;
  const ctx = await requireOrg();
  const project = await pageProject(projectId, ctx.org.id);
  return { title: project.name };
}

export default async function ProjectPage(props: PageProps<"/projects/[projectId]">) {
  const { projectId } = await props.params;
  const { env, view } = await props.searchParams;
  const ctx = await requireOrg();
  const project = await pageProject(projectId, ctx.org.id);
  const { envs, current } = await resolveEnvironment(projectId, typeof env === "string" ? env : undefined);
  const [services, kept] = await Promise.all([environmentServices(current.id), environmentKept(current.id, project.organizationId)]);
  // No view in the link: the one chosen last time (a cookie the view toggle sets).
  const chosen = typeof view === "string" ? view : (await cookies()).get("serve-project-view")?.value;
  return (
    <ProjectView
      project={{ id: project.id, name: project.name, description: project.description, color: project.color, groupServices: project.groupServices }}
      environments={envs.map((e) => ({ id: e.id, name: e.name }))}
      environment={{ id: current.id, name: current.name }}
      initialServices={services}
      initialKept={kept}
      view={chosen === "canvas" || chosen === "list" ? chosen : "grid"}
      positions={current.canvas?.positions ?? {}}
    />
  );
}
