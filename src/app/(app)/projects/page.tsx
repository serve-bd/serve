import { cookies } from "next/headers";
import { requireOrg } from "@/server/auth";
import { projectSummaries } from "@/server/queries";
import { ProjectsScreen } from "./projects-list";

export const metadata = { title: "Projects" };

export default async function ProjectsPage() {
  const ctx = await requireOrg();
  const projects = await projectSummaries(ctx.org.id, ctx.projectIds);
  const view = (await cookies()).get("serve-projects-view")?.value === "list" ? "list" : "grid";
  return <ProjectsScreen projects={projects} initialView={view} canCreate={ctx.can("projects.manage")} />;
}
