import { NoAccess } from "@/components/no-access";
import { asc, eq, sql } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { pageProject } from "@/server/services/access";
import { resolveEnvironment } from "@/server/project-data";
import { getTemplates } from "@/server/services/templates";
import { engineList } from "@/server/databases/engines";
import { commandExists } from "@/server/process";
import { serversForOrg } from "@/server/servers/access";
import { NewServiceWizard, type CatalogTemplate } from "./wizard";

export const metadata = { title: "New service" };

export default async function NewServicePage(props: PageProps<"/projects/[projectId]/new">) {
  const { projectId } = await props.params;
  const { env, type, template, repo, branch, credential, builder, server, root } = await props.searchParams;
  const ctx = await requireOrg();
  if (!ctx.can("services.manage")) return <NoAccess permission="services.manage" />;
  const project = await pageProject(projectId, ctx.org.id);
  const { current } = await resolveEnvironment(projectId, typeof env === "string" ? env : undefined);
  const [credentials, nixpacks, servers, custom, templates, registries] = await Promise.all([
    db
      .select({
        id: schema.gitCredential.id,
        name: schema.gitCredential.name,
        provider: schema.gitCredential.provider,
        oauth: sql<boolean>`${schema.gitCredential.oauthAppId} is not null`,
      })
      .from(schema.gitCredential)
      .where(eq(schema.gitCredential.organizationId, ctx.org.id)),
    commandExists("nixpacks"),
    serversForOrg(ctx.org.id),
    db.select().from(schema.customTemplate).where(eq(schema.customTemplate.organizationId, ctx.org.id)).orderBy(asc(schema.customTemplate.name)),
    getTemplates(),
    db
      .select({ id: schema.containerRegistry.id, name: schema.containerRegistry.name, host: schema.containerRegistry.host })
      .from(schema.containerRegistry)
      .where(eq(schema.containerRegistry.organizationId, ctx.org.id))
      .orderBy(asc(schema.containerRegistry.name)),
  ]);
  const catalog: CatalogTemplate[] = [
    ...custom.map((t) => ({
      id: `custom:${t.id}`,
      name: t.name,
      description: t.description,
      category: t.category,
      website: null,
      popular: false,
      hostAccess: false,
      custom: true,
      iconUrl: t.iconUrl,
      note: null,
      vars: t.vars,
    })),
    ...templates.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      website: t.website,
      popular: !!t.popular,
      hostAccess: !!t.hostAccess,
      custom: false,
      iconUrl: null,
      note: t.note ?? null,
      vars: t.vars,
    })),
  ];

  return (
    <NewServiceWizard
      header={{
        breadcrumbs: [{ label: "Projects", href: "/projects" }, { label: project.name, href: `/projects/${project.id}?env=${current.name}` }, { label: "New service" }],
      }}
      projectId={project.id}
      environmentId={current.id}
      environmentName={current.name}
      servers={servers.map((s) => ({ id: s.id, name: s.name, host: s.host, status: s.status, isLocal: s.isLocal }))}
      credentials={credentials}
      registries={registries}
      nixpacks={nixpacks}
      initialServerId={typeof server === "string" && servers.some((s) => s.id === server) ? server : null}
      initialType={typeof type === "string" ? type : null}
      initialTemplate={typeof template === "string" ? template : null}
      initialGit={
        typeof repo === "string" && repo
          ? {
              repository: repo,
              branch: typeof branch === "string" && branch ? branch : "main",
              credentialId: typeof credential === "string" && credential ? credential : null,
              builder: typeof builder === "string" ? builder : null,
              rootDir: typeof root === "string" ? root : null,
            }
          : null
      }
      templates={catalog}
      canManageTemplates={ctx.can("integrations.manage")}
      engines={engineList.map((e) => ({
        engine: e.engine,
        label: e.label,
        versions: e.versions,
        defaultVersion: e.defaultVersion,
        hasUser: e.hasUser,
        hasDatabase: e.hasDatabase,
        defaultUser: e.defaultUser,
        defaultDatabase: e.defaultDatabase,
        imagePattern: e.imagePattern.source,
      }))}
    />
  );
}
