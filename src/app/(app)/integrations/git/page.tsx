import { desc, eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { GitProviders } from "./git-providers";

export const metadata = { title: "Git providers" };

export default async function GitPage() {
  const ctx = await requireOrg();
  const creds = await db
    .select({ id: schema.gitCredential.id, name: schema.gitCredential.name, provider: schema.gitCredential.provider, publicInfo: schema.gitCredential.publicInfo, baseUrl: schema.gitCredential.baseUrl, createdAt: schema.gitCredential.createdAt })
    .from(schema.gitCredential)
    .where(eq(schema.gitCredential.organizationId, ctx.org.id))
    .orderBy(desc(schema.gitCredential.createdAt));
  return (
    <>
      <PageHeader title="Git providers" description="Access tokens and deploy keys for private repositories." />
      <PageBody className="max-w-3xl">
        <GitProviders isAdmin={ctx.isAdmin} credentials={creds.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() }))} />
      </PageBody>
    </>
  );
}
