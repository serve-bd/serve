import { asc, eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import { pageService } from "@/server/services/access";
import { providedVars } from "@/server/services/variables";
import { PageBody } from "@/components/shell/page-header";
import { VariablesEditor } from "./variables-editor";

export const metadata = { title: "Variables" };

export default async function VariablesPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/variables">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  const [vars, shared, siblings] = await Promise.all([
    db.select().from(schema.envVar).where(eq(schema.envVar.serviceId, serviceId)).orderBy(asc(schema.envVar.key)),
    db.select({ key: schema.sharedVar.key }).from(schema.sharedVar).where(eq(schema.sharedVar.environmentId, service.environmentId)),
    db.select().from(schema.service).where(eq(schema.service.environmentId, service.environmentId)),
  ]);
  const references = siblings
    .filter((s) => s.id !== service.id)
    .map((s) => ({ name: s.name, keys: Object.keys(providedVars(s)).filter((k) => !k.startsWith("SERVE_SERVICE")) }));

  return (
    <PageBody>
      <VariablesEditor
        serviceId={service.id}
        type={service.type}
        status={service.status}
        initial={vars.map((v) => ({ key: v.key, value: decryptOrNull(v.value) ?? "", buildTime: v.buildTime, runtime: v.runtime }))}
        shared={shared.map((s) => s.key)}
        references={references}
        settingsHref={`/projects/${projectId}/settings`}
      />
    </PageBody>
  );
}
