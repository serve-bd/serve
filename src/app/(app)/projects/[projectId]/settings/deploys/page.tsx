import { asc, eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { pageProject } from "@/server/services/access";
import { DeployRulesSettings } from "./deploy-rules";

export const metadata = { title: "Deploy rules" };

export default async function Page(props: PageProps<"/projects/[projectId]/settings/deploys">) {
  const { projectId } = await props.params;
  const ctx = await requireOrg();
  const project = await pageProject(projectId, ctx.org.id);
  const envs = await db
    .select({ id: schema.environment.id, name: schema.environment.name })
    .from(schema.environment)
    .where(eq(schema.environment.projectId, project.id))
    .orderBy(asc(schema.environment.createdAt));
  return (
    <DeployRulesSettings key={JSON.stringify(project.deployRules)} projectId={project.id} rules={project.deployRules ?? null} envs={envs} canManage={ctx.can("projects.manage")} />
  );
}
