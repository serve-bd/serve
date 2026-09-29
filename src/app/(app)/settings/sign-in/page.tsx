import { asc } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { publicBaseUrl } from "@/server/git/github-app";
import { getSetting } from "@/server/settings";
import { callbackUrl, redact, SSO_PROVIDERS } from "@/server/sso/config";
import { SignInSettingsView } from "./sign-in-settings";

export const metadata = { title: "Sign-in" };

export default async function SignInSettingsPage() {
  const [settings, base, orgs] = await Promise.all([
    getSetting("signIn"),
    publicBaseUrl(),
    db.select({ id: schema.organization.id, name: schema.organization.name }).from(schema.organization).orderBy(asc(schema.organization.name)),
  ]);
  return (
    <SignInSettingsView
      passwordEnabled={settings.passwordEnabled !== false}
      forcedPassword={process.env.SERVE_ALLOW_PASSWORD_LOGIN === "1"}
      providers={SSO_PROVIDERS.map((id) => ({
        id,
        callbackUrl: callbackUrl(base, id),
        config: settings.providers[id] ? redact(settings.providers[id]) : null,
      }))}
      organizations={orgs}
      httpsWarning={!base.startsWith("https://")}
    />
  );
}
