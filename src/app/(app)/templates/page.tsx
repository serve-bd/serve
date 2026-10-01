import { asc, eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { getTemplates } from "@/server/services/templates";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { TemplatesView } from "./templates-view";

export const metadata = { title: "Templates" };

export default async function TemplatesPage() {
  const ctx = await requireOrg();
  const templates = await getTemplates();
  const custom = await db
    .select({
      id: schema.customTemplate.id,
      name: schema.customTemplate.name,
      description: schema.customTemplate.description,
      category: schema.customTemplate.category,
      iconUrl: schema.customTemplate.iconUrl,
      compose: schema.customTemplate.compose,
      updatedAt: schema.customTemplate.updatedAt,
      author: schema.user.name,
    })
    .from(schema.customTemplate)
    .leftJoin(schema.user, eq(schema.customTemplate.createdBy, schema.user.id))
    .where(eq(schema.customTemplate.organizationId, ctx.org.id))
    .orderBy(asc(schema.customTemplate.name));

  return (
    <>
      <PageHeader title="Templates" description="One-click services for this organization. Built-in templates plus your own compose files." />
      <PageBody>
        <TemplatesView
          canManage={ctx.can("integrations.manage")}
          custom={custom.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            category: t.category,
            iconUrl: t.iconUrl,
            services: (t.compose.match(/^ {2}[A-Za-z0-9._-]+:\s*$/gm) ?? []).length,
            updatedAt: t.updatedAt.toISOString(),
            author: t.author,
          }))}
          builtIn={templates.map((t) => ({ id: t.id, name: t.name, description: t.description, category: t.category, hostAccess: !!t.hostAccess, website: t.website }))}
        />
      </PageBody>
    </>
  );
}
