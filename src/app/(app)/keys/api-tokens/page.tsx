import { and, asc, desc, eq } from "drizzle-orm";
import { allowedScopes } from "@/lib/permissions";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { publicBaseUrl } from "@/server/git/github-app";
import { TokensView } from "./tokens-view";

export const metadata = { title: "API tokens" };

export default async function TokensPage() {
  const ctx = await requireOrg();
  const [tokens, projects, baseUrl] = await Promise.all([
    db
      .select({
        id: schema.apiToken.id,
        name: schema.apiToken.name,
        prefix: schema.apiToken.prefix,
        scopes: schema.apiToken.scopes,
        projectIds: schema.apiToken.projectIds,
        expiresAt: schema.apiToken.expiresAt,
        lastUsedAt: schema.apiToken.lastUsedAt,
        lastUsedIp: schema.apiToken.lastUsedIp,
        createdAt: schema.apiToken.createdAt,
        userName: schema.user.name,
        userId: schema.apiToken.userId,
      })
      .from(schema.apiToken)
      .innerJoin(schema.user, eq(schema.apiToken.userId, schema.user.id))
      // Members who do not manage members only see their own tokens.
      .where(and(eq(schema.apiToken.organizationId, ctx.org.id), ctx.can("members.manage") ? undefined : eq(schema.apiToken.userId, ctx.user.id)))
      .orderBy(desc(schema.apiToken.createdAt)),
    db
      .select({ id: schema.project.id, name: schema.project.name })
      .from(schema.project)
      .where(eq(schema.project.organizationId, ctx.org.id))
      .orderBy(asc(schema.project.name))
      .then((rows) => rows.filter((p) => ctx.canAccessProject(p.id))),
    publicBaseUrl(),
  ]);
  return (
    <div className="max-w-4xl">
      <TokensView
        canManage={ctx.can("members.manage")}
        me={ctx.user.id}
        allowed={[...allowedScopes(ctx.permissions, ctx.isAdmin)]}
        limitedToProjects={!!ctx.projectIds}
        baseUrl={baseUrl}
        projects={projects}
        tokens={tokens.map((t) => ({
          ...t,
          expiresAt: t.expiresAt?.toISOString() ?? null,
          lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
          createdAt: t.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
