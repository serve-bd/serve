import { asc, eq, inArray } from "drizzle-orm";
import { notFound } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { pageService } from "@/server/services/access";
import { branchesSupported } from "@/server/databases/branches";
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
  return (
    <PageBody>
      <BranchesView
        serviceId={service.id}
        serviceName={service.name}
        // References use the slug: always unique, unlike a name.
        refName={service.slug || referenceName(service.name)}
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
          };
        })}
        projectId={projectId}
      />
    </PageBody>
  );
}
