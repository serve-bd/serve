import { and, eq } from "drizzle-orm";
import { dashboardAddresses, passwordLoginAllowed, requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { isEmailConfigured } from "@/server/email/send";
import { getSetting } from "@/server/settings";
import { activeProviders, providerNames } from "@/server/sso/config";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { AccountView } from "./account-view";
import { PasskeysCard } from "./passkeys";
import { headers } from "next/headers";

export const metadata = { title: "Account" };

export default async function AccountPage(props: PageProps<"/account">) {
  const ctx = await requireOrg();
  const [signIn, { error, reauth }, credential, emailEnabled, passkeys, addresses, allowed, h] = await Promise.all([
    getSetting("signIn"),
    props.searchParams,
    // Accounts made through a sign-in provider have no password until one is set.
    db
      .select({ id: schema.account.id })
      .from(schema.account)
      .where(and(eq(schema.account.userId, ctx.user.id), eq(schema.account.providerId, "credential")))
      .limit(1),
    isEmailConfigured(),
    db
      .select({ id: schema.passkey.id, name: schema.passkey.name, createdAt: schema.passkey.createdAt, backedUp: schema.passkey.backedUp })
      .from(schema.passkey)
      .where(eq(schema.passkey.userId, ctx.user.id)),
    dashboardAddresses(),
    passwordLoginAllowed(),
    headers(),
  ]);
  // Passkeys belong to the address they are made on: the one this page was opened at.
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(",")[0].trim();
  const hostname = (addresses.hosts.includes(host) ? host : (addresses.hosts[0] ?? host)).replace(/:\d+$/, "");
  return (
    <>
      <PageHeader title="Account" description="Your profile, password and signed-in devices." />
      <PageBody className="max-w-3xl">
        <AccountView
          user={{ name: ctx.user.name, email: ctx.user.email, twoFactorEnabled: !!(ctx.user as { twoFactorEnabled?: boolean }).twoFactorEnabled }}
          providers={activeProviders(signIn).map((id) => ({ id, label: id === "oidc" ? signIn.providers.oidc?.label || providerNames.oidc : providerNames[id] }))}
          // A failed "Confirm it's you" sign-in comes back with ?reauth=failed; other errors are from linking.
          linkError={typeof error === "string" && reauth !== "failed" ? error : null}
          reauthError={reauth === "failed" ? (typeof error === "string" ? error : "") : null}
          hasPassword={credential.length > 0}
          canEmailPasswordLink={emailEnabled && signIn.passwordEnabled !== false}
          passkeys={
            <PasskeysCard
              passkeys={passkeys.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt?.toISOString() ?? null, backedUp: p.backedUp }))}
              hostname={hostname}
              allowed={allowed}
              email={ctx.user.email}
            />
          }
        />
      </PageBody>
    </>
  );
}
