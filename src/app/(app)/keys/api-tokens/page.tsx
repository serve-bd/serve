import { asc, desc, eq } from "drizzle-orm";
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
      })
      .from(schema.apiToken)
      .innerJoin(schema.user, eq(schema.apiToken.userId, schema.user.id))
      .where(eq(schema.apiToken.organizationId, ctx.org.id))
      .orderBy(desc(schema.apiToken.createdAt)),
    db
      .select({ id: schema.project.id, name: schema.project.name })
      .from(schema.project)
      .where(eq(schema.project.organizationId, ctx.org.id))
      .orderBy(asc(schema.project.name)),
    publicBaseUrl(),
  ]);
  return (
    <div className="max-w-4xl">
        <TokensView
          isAdmin={ctx.isAdmin}
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
