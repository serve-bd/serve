import { and, eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { isEmailConfigured } from "@/server/email/send";
import { getSetting } from "@/server/settings";
import { activeProviders, providerNames } from "@/server/sso/config";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { AccountView } from "./account-view";

export const metadata = { title: "Account" };

export default async function AccountPage(props: PageProps<"/account">) {
  const ctx = await requireOrg();
  const [signIn, { error }, credential, emailEnabled] = await Promise.all([
    getSetting("signIn"),
    props.searchParams,
    // Accounts made through a sign-in provider have no password until one is set.
    db
      .select({ id: schema.account.id })
      .from(schema.account)
      .where(and(eq(schema.account.userId, ctx.user.id), eq(schema.account.providerId, "credential")))
      .limit(1),
    isEmailConfigured(),
  ]);
  return (
    <>
      <PageHeader title="Account" description="Your profile, password and signed-in devices." />
      <PageBody className="max-w-3xl">
        <AccountView
          user={{ name: ctx.user.name, email: ctx.user.email, twoFactorEnabled: !!(ctx.user as { twoFactorEnabled?: boolean }).twoFactorEnabled }}
          providers={activeProviders(signIn).map((id) => ({ id, label: id === "oidc" ? signIn.providers.oidc?.label || providerNames.oidc : providerNames[id] }))}
          linkError={typeof error === "string" ? error : null}
          hasPassword={credential.length > 0}
          canEmailPasswordLink={emailEnabled && signIn.passwordEnabled !== false}
        />
      </PageBody>
    </>
  );
}
