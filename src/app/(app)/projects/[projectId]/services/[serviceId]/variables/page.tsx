import { asc, eq, or } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import { pageService } from "@/server/services/access";
import { providedVars } from "@/server/services/variables";
import { meshMemberIds, reachesPrivately } from "@/server/mesh/members";
import { runServerIds } from "@/server/deploy/distribution";
import { PageBody } from "@/components/shell/page-header";
import { composeVariables } from "@/lib/compose-vars";
import { referenceName } from "@/lib/refs";
import { VariablesEditor } from "./variables-editor";

export const metadata = { title: "Variables" };

export default async function VariablesPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/variables">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  const canSeeSecrets = ctx.can("variables.view-secrets");
  const [vars, shared, siblings, scoped, servers, mesh] = await Promise.all([
    db.select().from(schema.envVar).where(eq(schema.envVar.serviceId, serviceId)).orderBy(asc(schema.envVar.key)),
    db.select({ key: schema.sharedVar.key }).from(schema.sharedVar).where(eq(schema.sharedVar.environmentId, service.environmentId)),
    db.select().from(schema.service).where(eq(schema.service.environmentId, service.environmentId)),
    db
      .select({ key: schema.sharedVar.key, projectId: schema.sharedVar.projectId })
      .from(schema.sharedVar)
      .where(or(eq(schema.sharedVar.projectId, projectId), eq(schema.sharedVar.organizationId, ctx.org.id)))
      .orderBy(asc(schema.sharedVar.key)),
    db.select({ id: schema.server.id, name: schema.server.name }).from(schema.server),
    meshMemberIds(),
  ]);
  const serverName = new Map(servers.map((s) => [s.id, s.name]));
  const projectKeys = scoped.filter((v) => v.projectId).map((v) => v.key);
  const orgKeys = scoped.filter((v) => !v.projectId).map((v) => v.key);
  const envKeys = [...new Set(shared.map((s) => s.key))].sort();
  const references = [
    ...(envKeys.length ? [{ name: "environment", label: "Environment variables", keys: envKeys }] : []),
    ...siblings
      .filter((s) => s.id !== service.id)
      .map((s) => {
        // Names two services share do not resolve; point at the unique slug instead.
        const shared = siblings.filter((x) => referenceName(x.name) === referenceName(s.name)).length > 1;
        const reachable = reachesPrivately(mesh, runServerIds(service.serverId, service.type === "app" ? service.distribution : null), {
          serverId: s.serverId,
          servers: runServerIds(s.serverId, s.type === "app" ? s.distribution : null),
        });
        // On another server, or reachable from this service's main server but not from one of its extra servers.
        const elsewhere = s.serverId !== service.serverId || !reachable;
        return {
          name: shared ? s.slug : s.name,
          label: shared ? `${s.name} (${s.slug})` : undefined,
          keys: Object.keys(providedVars(s)).filter((k) => !k.startsWith("SERVE_SERVICE")),
          note: elsewhere
            ? reachable
              ? `On ${serverName.get(s.serverId) ?? "another server"}, over the private network`
              : `On ${serverName.get(s.serverId) ?? "another server"}: private names need both servers in the same private network`
            : undefined,
          warn: elsewhere && !reachable,
        };
      }),
    ...(projectKeys.length ? [{ name: "project", label: "Project variables", keys: projectKeys }] : []),
    ...(orgKeys.length ? [{ name: "org", label: "Organization variables", keys: orgKeys }] : []),
    // Different in each replica: shard a bot or split work, e.g. SHARD_ID=${{replica.index}}.
    ...(service.type === "app"
      ? [
          {
            name: "replica",
            label: "This replica",
            note: "Different in each replica, like SHARD_ID",
            keys: ["index", "number", "count"],
            addAs: { index: "REPLICA_INDEX", number: "REPLICA_NUMBER", count: "REPLICA_COUNT" },
          },
        ]
      : []),
  ];

  return (
    <PageBody>
      <VariablesEditor
        serviceId={service.id}
        type={service.type}
        status={service.status}
        initial={vars.map((v) => {
          const value = decryptOrNull(v.value) ?? "";
          // A value made only of references is not secret; anything with literal text (a password
          // next to a reference) stays on the server for roles without secret access.
          return canSeeSecrets || /^(\$\{\{[^}]+\}\})+$/.test(value.trim())
            ? { key: v.key, value, buildTime: v.buildTime, runtime: v.runtime }
            : { key: v.key, value: "", buildTime: v.buildTime, runtime: v.runtime, hidden: true, from: v.key };
        })}
        canEdit={ctx.can("variables.edit")}
        canSeeSecrets={canSeeSecrets}
        references={references}
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
