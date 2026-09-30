import { desc, eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { publicBaseUrl, readAppSecret } from "@/server/git/github-app";
import { GitProviders } from "./git-providers";
import type { OAuthAppRow } from "./oauth-apps";
import { isPublicUrl, oauthBaseUrl } from "@/server/git/public-url";

export const metadata = { title: "Git providers" };

export default async function GitPage() {
  const ctx = await requireOrg();
  const rows = await db.select().from(schema.gitCredential).where(eq(schema.gitCredential.organizationId, ctx.org.id)).orderBy(desc(schema.gitCredential.createdAt));
  const base = await publicBaseUrl();
  const [oauthRows, oauthBase] = await Promise.all([
    db.select().from(schema.gitOAuthApp).where(eq(schema.gitOAuthApp.organizationId, ctx.org.id)).orderBy(desc(schema.gitOAuthApp.createdAt)),
    oauthBaseUrl(),
  ]);
  const oauthApps: OAuthAppRow[] = oauthRows.map((a) => {
    const cred = rows.find((c) => c.oauthAppId === a.id);
    return {
      id: a.id,
      provider: a.provider,
      name: a.name,
      baseUrl: a.baseUrl,
      groupPath: a.groupPath,
      createdAt: a.createdAt.toISOString(),
      connection: cred ? { login: cred.publicInfo, connectedAt: cred.updatedAt.toISOString() } : null,
    };
  });

  // OAuth connections are shown with their app.
  const credentials = rows
    .filter((c) => !c.oauthAppId)
    .map((c) => {
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
    <GitProviders
      isAdmin={ctx.can("integrations.manage")}
      isInstanceAdmin={ctx.isInstanceAdmin}
      credentials={credentials}
      baseUrl={base}
      publicUrl={isPublicUrl(base)}
      oauthApps={oauthApps}
      oauthBase={oauthBase.ok ? { url: oauthBase.url, ok: true } : { url: oauthBase.url, ok: false, error: oauthBase.error }}
    />
  );
}
