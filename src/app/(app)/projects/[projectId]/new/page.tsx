import { eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { pageProject } from "@/server/services/access";
import { resolveEnvironment } from "@/server/project-data";
import { templates } from "@/server/services/templates";
import { engineList } from "@/server/databases/engines";
import { commandExists } from "@/server/process";
import { serversForOrg } from "@/server/servers/access";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { NewServiceWizard } from "./wizard";

export const metadata = { title: "New service" };

export default async function NewServicePage(props: PageProps<"/projects/[projectId]/new">) {
  const { projectId } = await props.params;
  const { env, type } = await props.searchParams;
  const ctx = await requireOrg();
  const project = await pageProject(projectId, ctx.org.id);
  const { current } = await resolveEnvironment(projectId, typeof env === "string" ? env : undefined);
  const [credentials, nixpacks, servers] = await Promise.all([
    db
      .select({ id: schema.gitCredential.id, name: schema.gitCredential.name, provider: schema.gitCredential.provider })
      .from(schema.gitCredential)
      .where(eq(schema.gitCredential.organizationId, ctx.org.id)),
    commandExists("nixpacks"),
    serversForOrg(ctx.org.id),
  ]);

  return (
    <>
      <PageHeader
        title="New service"
        description={`Add to ${project.name} · ${current.name}`}
        breadcrumbs={[
          { label: "Projects", href: "/projects" },
          { label: project.name, href: `/projects/${project.id}?env=${current.name}` },
          { label: "New service" },
        ]}
      />
      <PageBody>
        <NewServiceWizard
          projectId={project.id}
          environmentId={current.id}
          environmentName={current.name}
          servers={servers.map((s) => ({ id: s.id, name: s.name, host: s.host, status: s.status, isLocal: s.isLocal }))}
          credentials={credentials}
          nixpacks={nixpacks}
          initialType={typeof type === "string" ? type : null}
          templates={templates.map((t) => ({ id: t.id, name: t.name, description: t.description, category: t.category }))}
          engines={engineList.map((e) => ({
            engine: e.engine,
            label: e.label,
            versions: e.versions,
            defaultVersion: e.defaultVersion,
            hasUser: e.hasUser,
            hasDatabase: e.hasDatabase,
            defaultUser: e.defaultUser,
            defaultDatabase: e.defaultDatabase,
          }))}
        />
      </PageBody>
    </>
  );
}
