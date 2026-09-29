import { asc, eq, or } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import { pageService } from "@/server/services/access";
import { providedVars } from "@/server/services/variables";
import { PageBody } from "@/components/shell/page-header";
import { composeVariables } from "@/lib/compose-vars";
import { VariablesEditor } from "./variables-editor";

export const metadata = { title: "Variables" };

export default async function VariablesPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/variables">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  const canSeeSecrets = ctx.can("variables.view-secrets");
  const [vars, shared, siblings, scoped] = await Promise.all([
    db.select().from(schema.envVar).where(eq(schema.envVar.serviceId, serviceId)).orderBy(asc(schema.envVar.key)),
    db.select({ key: schema.sharedVar.key }).from(schema.sharedVar).where(eq(schema.sharedVar.environmentId, service.environmentId)),
    db.select().from(schema.service).where(eq(schema.service.environmentId, service.environmentId)),
    db
      .select({ key: schema.sharedVar.key, projectId: schema.sharedVar.projectId })
      .from(schema.sharedVar)
      .where(or(eq(schema.sharedVar.projectId, projectId), eq(schema.sharedVar.organizationId, ctx.org.id)))
      .orderBy(asc(schema.sharedVar.key)),
  ]);
  const projectKeys = scoped.filter((v) => v.projectId).map((v) => v.key);
  const orgKeys = scoped.filter((v) => !v.projectId).map((v) => v.key);
  const references = [
    ...siblings.filter((s) => s.id !== service.id).map((s) => ({ name: s.name, keys: Object.keys(providedVars(s)).filter((k) => !k.startsWith("SERVE_SERVICE")) })),
    ...(projectKeys.length ? [{ name: "project", label: "Project variables", keys: projectKeys }] : []),
    ...(orgKeys.length ? [{ name: "org", label: "Organization variables", keys: orgKeys }] : []),
  ];

  return (
    <PageBody>
      <VariablesEditor
        serviceId={service.id}
        type={service.type}
        status={service.status}
        initial={vars.map((v) => {
          const value = decryptOrNull(v.value) ?? "";
          // References are not secret; everything else stays on the server for roles without secret access.
          return canSeeSecrets || value.includes("${{")
            ? { key: v.key, value, buildTime: v.buildTime, runtime: v.runtime }
            : { key: v.key, value: "", buildTime: v.buildTime, runtime: v.runtime, hidden: true, from: v.key };
        })}
        canEdit={ctx.can("variables.edit")}
        canSeeSecrets={canSeeSecrets}
        shared={shared.map((s) => s.key)}
        references={references}
        settingsHref={`/projects/${projectId}/settings`}
        composeVars={
          service.compose
            ? composeVariables(service.compose.content)
                .filter((v) => !v.hasDefault)
                .map((v) => v.name)
            : []
        }
      />
    </PageBody>
  );
}
