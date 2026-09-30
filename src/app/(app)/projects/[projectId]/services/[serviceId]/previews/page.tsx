import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { pageService } from "@/server/services/access";
import { pickPrimaryDomain } from "@/lib/domains";
import { PageBody } from "@/components/shell/page-header";
import { PreviewsList } from "./previews-list";

export const metadata = { title: "Previews" };

export default async function PreviewsPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/previews">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  if (service.type !== "app" || service.source?.type !== "git" || service.parentServiceId) redirect(`/projects/${projectId}/services/${serviceId}`);
  const previews = await db
    .select()
    .from(schema.service)
    .where(and(eq(schema.service.parentServiceId, service.id), isNotNull(schema.service.previewPr), eq(schema.service.type, "app")))
    .orderBy(desc(schema.service.previewPr));
  const ids = previews.map((p) => p.id);
  const [domains, deployments, copies] = ids.length
    ? await Promise.all([
        db.select().from(schema.domain).where(inArray(schema.domain.serviceId, ids)),
        db
          .selectDistinctOn([schema.deployment.serviceId])
          .from(schema.deployment)
          .where(inArray(schema.deployment.serviceId, ids))
          .orderBy(schema.deployment.serviceId, desc(schema.deployment.createdAt)),
        db
          .select({ id: schema.service.id, parentServiceId: schema.service.parentServiceId, status: schema.service.status })
          .from(schema.service)
          .where(inArray(schema.service.parentServiceId, ids)),
      ])
    : [[], [], []];
  return (
    <PageBody>
      <PreviewsList
        projectId={projectId}
        serviceId={service.id}
        enabled={service.previewsEnabled}
        previewDomain={service.previewDomain}
        canManage={ctx.can("services.manage")}
        canDeploy={ctx.can("services.deploy")}
        previews={previews.map((p) => {
          const domain = pickPrimaryDomain(domains.filter((d) => d.serviceId === p.id));
          const dep = deployments.find((d) => d.serviceId === p.id);
          return {
            id: p.id,
            pr: p.previewPr!,
            status: p.status,
            branch: p.source?.type === "git" ? p.source.branch : null,
            url: domain ? `${domain.https ? "https" : "http"}://${domain.hostname}` : null,
            createdAt: p.createdAt.toISOString(),
            database: copies.some((c) => c.parentServiceId === p.id),
            deployment: dep ? { id: dep.id, status: dep.status, title: dep.commitMessage, sha: dep.commitSha, createdAt: dep.createdAt.toISOString() } : null,
          };
        })}
      />
    </PageBody>
  );
}
