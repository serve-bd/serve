import { desc, eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { env } from "@/server/env";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { TokensView } from "./tokens-view";

export const metadata = { title: "API tokens" };

export default async function TokensPage() {
  const ctx = await requireOrg();
  const tokens = await db
    .select({ id: schema.apiToken.id, name: schema.apiToken.name, prefix: schema.apiToken.prefix, lastUsedAt: schema.apiToken.lastUsedAt, createdAt: schema.apiToken.createdAt, userName: schema.user.name })
    .from(schema.apiToken)
    .innerJoin(schema.user, eq(schema.apiToken.userId, schema.user.id))
    .where(eq(schema.apiToken.organizationId, ctx.org.id))
    .orderBy(desc(schema.apiToken.createdAt));
  return (
    <>
      <PageHeader title="API tokens" description="Automate deployments from CI or scripts with the Serve API." />
      <PageBody className="max-w-3xl">
        <TokensView
          isAdmin={ctx.isAdmin}
          baseUrl={env.appUrl.replace(/\/$/, "")}
          tokens={tokens.map((t) => ({ ...t, lastUsedAt: t.lastUsedAt?.toISOString() ?? null, createdAt: t.createdAt.toISOString() }))}
        />
      </PageBody>
    </>
  );
}
