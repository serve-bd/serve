import { asc, eq, inArray } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { publicBaseUrl } from "@/server/git/github-app";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { TagsView } from "./tags-view";

export const metadata = { title: "Tags" };

export default async function TagsPage() {
  const ctx = await requireOrg();
  const tags = await db.select().from(schema.tag).where(eq(schema.tag.organizationId, ctx.org.id)).orderBy(asc(schema.tag.name));
  const links = tags.length
    ? await db
        .select({
          tagId: schema.serviceTag.tagId,
          id: schema.service.id,
          name: schema.service.name,
          type: schema.service.type,
          status: schema.service.status,
          projectId: schema.service.projectId,
          project: schema.project.name,
          environment: schema.environment.name,
        })
        .from(schema.serviceTag)
        .innerJoin(schema.service, eq(schema.service.id, schema.serviceTag.serviceId))
        .innerJoin(schema.project, eq(schema.project.id, schema.service.projectId))
        .innerJoin(schema.environment, eq(schema.environment.id, schema.service.environmentId))
        .where(
          inArray(
            schema.serviceTag.tagId,
            tags.map((t) => t.id),
          ),
        )
        .orderBy(asc(schema.project.name), asc(schema.service.name))
    : [];
  const canManage = ctx.can("services.manage");
  const base = await publicBaseUrl();
  return (
    <>
      <PageHeader title="Tags" description="Labels on services across projects. Redeploy everything with a tag at once, from here or from CI." />
      <PageBody>
        <TagsView
          canManage={canManage}
          canDeploy={ctx.can("services.deploy")}
          tags={tags.map((t) => ({
            id: t.id,
            name: t.name,
            color: t.color,
            // The hook carries its secret: only roles that manage services see it.
            hook: canManage ? `${base}/api/deploy-hooks/tags/${t.id}?token=${t.deploySecret}` : null,
            services: links.filter((l) => l.tagId === t.id && ctx.canAccessProject(l.projectId)),
          }))}
        />
      </PageBody>
    </>
  );
}
