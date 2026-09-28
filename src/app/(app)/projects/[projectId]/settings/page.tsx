import { asc, eq, inArray } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import { pageProject } from "@/server/services/access";
import { resolveEnvironment } from "@/server/project-data";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { ProjectSettings } from "./project-settings";

export const metadata = { title: "Project settings" };

export default async function ProjectSettingsPage(props: PageProps<"/projects/[projectId]/settings">) {
  const { projectId } = await props.params;
  const { env } = await props.searchParams;
  const ctx = await requireOrg();
  const project = await pageProject(projectId, ctx.org.id);
  const { envs, current } = await resolveEnvironment(projectId, typeof env === "string" ? env : undefined);
  const [shared, counts] = await Promise.all([
    db.select().from(schema.sharedVar).where(eq(schema.sharedVar.environmentId, current.id)).orderBy(asc(schema.sharedVar.key)),
    db.select({ environmentId: schema.service.environmentId }).from(schema.service).where(inArray(schema.service.environmentId, envs.map((e) => e.id))),
  ]);
  return (
    <>
      <PageHeader
        title="Project settings"
        breadcrumbs={[{ label: "Projects", href: "/projects" }, { label: project.name, href: `/projects/${project.id}?env=${current.name}` }, { label: "Settings" }]}
      />
      <PageBody className="max-w-3xl">
        <ProjectSettings
          project={{ id: project.id, name: project.name, description: project.description ?? "", color: project.color }}
          environments={envs.map((e) => ({ id: e.id, name: e.name, services: counts.filter((c) => c.environmentId === e.id).length }))}
          environment={{ id: current.id, name: current.name }}
          shared={shared.map((s) => ({ key: s.key, value: decryptOrNull(s.value) ?? "" }))}
          isAdmin={ctx.isAdmin}
        />
      </PageBody>
    </>
  );
}
