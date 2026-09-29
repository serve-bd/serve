import { desc, eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { publicBaseUrl, readAppSecret } from "@/server/git/github-app";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { GitProviders } from "./git-providers";

export const metadata = { title: "Git providers" };

function isPublicUrl(url: string) {
  try {
    const host = new URL(url).hostname;
    return !(host === "localhost" || host.endsWith(".local") || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host));
  } catch {
    return false;
  }
}

export default async function GitPage() {
  const ctx = await requireOrg();
  const rows = await db
    .select()
    .from(schema.gitCredential)
    .where(eq(schema.gitCredential.organizationId, ctx.org.id))
    .orderBy(desc(schema.gitCredential.createdAt));
  const base = await publicBaseUrl();

  const credentials = rows.map((c) => {
    const app = c.provider === "github-app" ? readAppSecret(c) : null;
    return {
      id: c.id,
      name: c.name,
      provider: c.provider,
      publicInfo: c.provider === "ssh" ? c.publicInfo : c.provider === "github-app" ? null : c.publicInfo,
      createdAt: c.createdAt.toISOString(),
      app: app ? { slug: app.slug, account: app.account, installed: !!app.installationId, settingsUrl: `https://github.com/settings/apps/${app.slug}` } : null,
    };
  });

  return (
    <>
      <PageHeader title="Git providers" description="Connect GitHub to deploy private repositories, with push-to-deploy and pull request previews set up automatically." />
      <PageBody className="max-w-3xl">
        <GitProviders isAdmin={ctx.isAdmin} credentials={credentials} baseUrl={base} publicUrl={isPublicUrl(base)} />
      </PageBody>
    </>
  );
}
