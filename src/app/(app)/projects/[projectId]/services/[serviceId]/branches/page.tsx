import { asc, eq, inArray } from "drizzle-orm";
import { notFound } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { pageService } from "@/server/services/access";
import { branchesSupported, branchScrubEngines } from "@/server/databases/branches";
import { decryptOrNull } from "@/server/crypto";
import { PageBody } from "@/components/shell/page-header";
import { referenceName } from "@/lib/refs";
import { BranchesView } from "./branches-view";

export const metadata = { title: "Branches" };

export default async function BranchesPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/branches">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  if (!branchesSupported(service) || service.parentServiceId) notFound();
  const rows = await db.select().from(schema.databaseBranch).where(eq(schema.databaseBranch.serviceId, service.id)).orderBy(asc(schema.databaseBranch.createdAt));
  const previewIds = rows.flatMap((r) => (r.previewServiceId ? [r.previewServiceId] : []));
  const previews = previewIds.length
    ? await db.select({ id: schema.service.id, name: schema.service.name, pr: schema.service.previewPr }).from(schema.service).where(inArray(schema.service.id, previewIds))
    : [];
  // Services that use a branch, by the references in their variables (previews included).
  const refName = service.slug || referenceName(service.name);
  const neighbours = await db
    .select({ id: schema.service.id, name: schema.service.name, type: schema.service.type, status: schema.service.status, previewPr: schema.service.previewPr })
    .from(schema.service)
    .where(eq(schema.service.environmentId, service.environmentId));
  const vars = neighbours.length
    ? await db
        .select({ serviceId: schema.envVar.serviceId, key: schema.envVar.key, value: schema.envVar.value })
        .from(schema.envVar)
        .where(
          inArray(
            schema.envVar.serviceId,
            neighbours.map((n) => n.id),
          ),
        )
    : [];
  const escaped = refName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const usesBranch = new RegExp(`\\$\\{\\{\\s*${escaped}\\.branches\\.([a-z0-9-]+)\\.[A-Z_]+\\s*\\}\\}`, "g");
  const consumers = new Map<string, { id: string; name: string; status: string; previewPr: number | null; keys: string[] }[]>();
  for (const v of vars) {
    const value = decryptOrNull(v.value) ?? "";
    for (const m of value.matchAll(usesBranch)) {
      const n = neighbours.find((x) => x.id === v.serviceId);
      if (!n) continue;
      const list = consumers.get(m[1]) ?? [];
      const found = list.find((c) => c.id === n.id);
      if (found) {
        if (!found.keys.includes(v.key)) found.keys.push(v.key);
      } else list.push({ id: n.id, name: n.name, status: n.status, previewPr: n.previewPr, keys: [v.key] });
      consumers.set(m[1], list);
    }
  }
  return (
    <PageBody>
      <BranchesView
        serviceId={service.id}
        serviceName={service.name}
        engine={service.database?.engine ?? "postgres"}
        // References use the slug: always unique, unlike a name.
        refName={refName}
        status={service.status}
        cleanupSql={service.database?.branchCleanupSql ?? ""}
        scrubSupported={branchScrubEngines.has(service.database?.engine ?? "")}
        running={service.status === "running"}
        canManage={ctx.can("services.manage")}
        branches={rows.map((b) => {
          const preview = previews.find((p) => p.id === b.previewServiceId);
          return {
            id: b.id,
            name: b.name,
            database: b.database,
            status: b.status,
            error: b.error,
            sizeBytes: b.sizeBytes,
            copiedAt: b.copiedAt?.toISOString() ?? null,
            createdAt: b.createdAt.toISOString(),
            preview: preview ? { id: preview.id, pr: preview.pr } : null,
            scrubbed: b.scrubbed,
            sourceBranchId: b.sourceBranchId,
            consumers: consumers.get(b.name) ?? [],
          };
        })}
        projectId={projectId}
      />
    </PageBody>
  );
}
