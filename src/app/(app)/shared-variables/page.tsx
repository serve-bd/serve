import { asc, eq, inArray } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { SharedVariables, type Scope } from "./shared-variables";

export const metadata = { title: "Shared variables" };

export default async function SharedVariablesPage(props: PageProps<"/shared-variables">) {
  const params = await props.searchParams;
  const ctx = await requireOrg();
  const scope: Scope = params.scope === "project" || params.scope === "environment" ? params.scope : "org";

  const projects = await db
    .select({ id: schema.project.id, name: schema.project.name })
    .from(schema.project)
    .where(eq(schema.project.organizationId, ctx.org.id))
    .orderBy(asc(schema.project.name))
    .then((rows) => rows.filter((p) => ctx.canAccessProject(p.id)));
  const environments = projects.length
    ? await db
        .select({ id: schema.environment.id, name: schema.environment.name, projectId: schema.environment.projectId })
        .from(schema.environment)
        .where(
          inArray(
            schema.environment.projectId,
            projects.map((p) => p.id),
          ),
        )
        .orderBy(asc(schema.environment.createdAt))
    : [];

  const project = projects.find((p) => p.id === params.project) ?? projects[0] ?? null;
  const projectEnvs = environments.filter((e) => e.projectId === project?.id);
  const environment = projectEnvs.find((e) => e.name === params.env) ?? projectEnvs.find((e) => e.name === "production") ?? projectEnvs[0] ?? null;

  const where =
    scope === "org"
      ? eq(schema.sharedVar.organizationId, ctx.org.id)
      : scope === "project"
        ? project && eq(schema.sharedVar.projectId, project.id)
        : environment && eq(schema.sharedVar.environmentId, environment.id);
  const rows = where ? await db.select().from(schema.sharedVar).where(where).orderBy(asc(schema.sharedVar.key)) : [];
  // Organization values are admin-only; members see which keys exist.
  // Values are edited in place, so editing them needs seeing them.
  const canEdit = ctx.can("variables.edit") && ctx.can("variables.view-secrets") && (scope === "org" ? ctx.isAdmin : true);

  return (
    <>
      <PageHeader title="Shared variables" description="Define a value once and reference it from any service. Values are encrypted at rest." />
      <PageBody>
        <SharedVariables
          key={`${scope}:${project?.id ?? ""}:${environment?.id ?? ""}`}
          scope={scope}
          canEdit={canEdit}
          canDeploy={ctx.can("services.deploy")}
          projects={projects}
          environments={projectEnvs.map((e) => ({ id: e.id, name: e.name }))}
          project={project}
          environment={environment ? { id: environment.id, name: environment.name } : null}
          vars={rows.map((r) => ({ key: r.key, value: canEdit ? (decryptOrNull(r.value) ?? "") : "" }))}
        />
      </PageBody>
    </>
  );
}
