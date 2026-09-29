"use client";

import type * as React from "react";
import { AlertTriangle, CircleCheck, Trash2 } from "lucide-react";
import { SsoMark } from "@/components/sso-mark";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Badge, Card, CardBody, CardHeader, CopyField } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { useAction } from "@/hooks/use-action";
import { removeSsoProvider, saveSsoProvider, setPasswordLogin, testOidcIssuer } from "@/server/actions/sign-in";
import type { ProviderView, SsoProviderId } from "@/server/sso/config";
import { SettingsCard } from "../_components/settings-card";

type ProviderRow = { id: SsoProviderId; callbackUrl: string; config: ProviderView | null };

const titles: Record<SsoProviderId, string> = { github: "GitHub", google: "Google", oidc: "OpenID Connect" };

const help: Record<SsoProviderId, React.ReactNode> = {
  github: (
    <>
      On GitHub open <b>Settings → Developer settings → OAuth Apps → New OAuth App</b>. Use the dashboard address as the homepage and paste the callback URL below.
    </>
  ),
  google: (
    <>
      In Google Cloud open <b>APIs &amp; Services → Credentials → Create credentials → OAuth client ID</b>, type <b>Web application</b>, and add the callback URL below as an
      authorized redirect URI.
    </>
  ),
  oidc: (
    <>
      For your company login, like Okta, Microsoft Entra ID, Authentik or Keycloak. Create an OpenID Connect web application there, add the callback URL below as a redirect URI,
      and paste its issuer URL, client ID and secret.
    </>
  ),
};

const list = (v: string) =>
  v
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

export function SignInSettingsView({
  passwordEnabled,
  forcedPassword,
  providers,
  organizations,
  httpsWarning,
}: {
  passwordEnabled: boolean;
  forcedPassword: boolean;
  providers: ProviderRow[];
  organizations: { id: string; name: string }[];
  httpsWarning: boolean;
}) {
  const togglePassword = useAction((on: boolean) => setPasswordLogin(on), { success: "Password sign-in updated" });
  const active = providers.filter((p) => p.config?.enabled && p.config.hasSecret);

  return (
    <>
      <Card>
        <CardHeader title="Sign-in methods" description="How people sign in to this dashboard. Changes apply at once; nobody needs to restart anything." />
        <CardBody className="flex flex-col gap-4 py-5">
          <SwitchRow
            title="Email and password"
            description={
              active.length
                ? "Turn off to allow only the providers below. A Root admin must have linked one of them on their Account page first."
                : "The only way in until a provider below is on."
            }
            checked={passwordEnabled}
            disabled={togglePassword.pending || (passwordEnabled && !active.length)}
            onCheckedChange={(on) => togglePassword.run(on)}
          />
          {forcedPassword && (
            <p className="text-xs text-muted">
              <span className="font-mono">SERVE_ALLOW_PASSWORD_LOGIN=1</span> is set, so password sign-in stays available whatever this switch says.
            </p>
          )}
          {!passwordEnabled && !forcedPassword && (
            <p className="text-xs leading-relaxed text-muted">
              Locked out? Set <span className="font-mono">SERVE_ALLOW_PASSWORD_LOGIN=1</span> in the instance&apos;s environment and restart to allow password sign-in again.
            </p>
          )}
          {httpsWarning && (
            <p className="flex gap-2 rounded-xl border border-warn/25 bg-warn-soft px-3.5 py-2.5 text-xs leading-relaxed text-fg-2">
              <AlertTriangle className="mt-px size-3.5 flex-none text-warn" />
              The dashboard has no HTTPS domain yet. Most providers only accept https callback URLs; set one in Settings → Dashboard &amp; TLS.
            </p>
          )}
        </CardBody>
      </Card>

      {providers.map((p) => (
        <ProviderCard key={p.id} row={p} organizations={organizations} />
      ))}
    </>
  );
}

function ProviderCard({ row, organizations }: { row: ProviderRow; organizations: { id: string; name: string }[] }) {
  const confirm = useConfirm();
  const c = row.config;
  const remove = useAction(() => removeSsoProvider(row.id), { success: `${titles[row.id]} sign-in removed` });
  const test = useAction(testOidcIssuer, { refresh: false });
  const initial = {
    enabled: c?.enabled ?? true,
    clientId: c?.clientId ?? "",
    clientSecret: "",
    allowSignUp: c?.allowSignUp ?? false,
    allowedDomains: (c?.allowedDomains ?? []).join(", "),
    defaultOrganizationId: c?.defaultOrganizationId ?? "",
    defaultRole: (c?.defaultRole ?? "member") as string,
    issuer: c?.issuer ?? "",
    scopes: (c?.scopes ?? []).join(" "),
    label: c?.label ?? "",
  };
  const status = !c ? <Badge>Not set up</Badge> : c.enabled ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>;

  return (
    <SettingsCard
      key={JSON.stringify(c)}
      title={titles[row.id]}
      description={help[row.id]}
      initial={initial}
      actions={
        <span className="flex items-center gap-2">
          <SsoMark provider={row.id} className="size-5" />
          {status}
        </span>
      }
      footerNote={
        c ? (
          <Button
            type="button"
            size="sm"
            variant="danger-ghost"
            loading={remove.pending}
            onClick={async () => {
              if (
                await confirm({
                  title: `Remove ${titles[row.id]} sign-in?`,
                  description: "People who only sign in with it lose access until they use another method. Linked accounts stay, so turning it on again restores them.",
                  confirmLabel: "Remove",
                  danger: true,
                })
              )
                remove.run();
            }}
          >
            <Trash2 /> Remove
          </Button>
        ) : undefined
      }
      onSave={(v) =>
        saveSsoProvider(row.id, {
          enabled: v.enabled,
          clientId: v.clientId,
          clientSecret: v.clientSecret || undefined,
          allowSignUp: v.allowSignUp,
          allowedDomains: list(v.allowedDomains),
          defaultOrganizationId: v.defaultOrganizationId || null,
          defaultRole: v.defaultRole as "member" | "admin",
          ...(row.id === "oidc" ? { issuer: v.issuer, scopes: list(v.scopes), label: v.label } : {}),
        })
      }
    >
      {(v, set) => (
        <>
          <Field label="Callback URL" description="Register this exact address with the provider.">
            <CopyField value={row.callbackUrl} />
          </Field>
          {row.id === "oidc" && (
            <>
              <Field label="Issuer URL" description="Serve reads its /.well-known/openid-configuration.">
                <div className="flex gap-2">
                  <Input value={v.issuer} onChange={(e) => set("issuer")(e.target.value)} placeholder="https://login.example.com" className="font-mono text-[13px]" />
                  <Button
                    type="button"
                    size="md"
                    loading={test.pending}
                    disabled={!v.issuer.trim()}
                    onClick={async () => {
                      const res = await test.run(v.issuer);
                      if (res) toast.success("Issuer found", res.issuer);
                    }}
                  >
                    Test
                  </Button>
                </div>
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Button text" optional>
                  <Input value={v.label} onChange={(e) => set("label")(e.target.value)} placeholder="Sign in with SSO" maxLength={60} />
                </Field>
                <Field label="Scopes" optional description="Default: openid email profile.">
                  <Input value={v.scopes} onChange={(e) => set("scopes")(e.target.value)} placeholder="openid email profile" className="font-mono text-[13px]" />
                </Field>
              </div>
            </>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Client ID">
              <Input value={v.clientId} onChange={(e) => set("clientId")(e.target.value)} className="font-mono text-[13px]" autoComplete="off" />
            </Field>
            <Field label="Client secret" description={c?.hasSecret ? "Saved. Leave empty to keep it." : undefined}>
              <Input
                type="password"
                value={v.clientSecret}
                onChange={(e) => set("clientSecret")(e.target.value)}
                placeholder={c?.hasSecret ? "••••••••" : ""}
                className="font-mono text-[13px]"
                autoComplete="new-password"
              />
            </Field>
          </div>
          <SwitchRow title="Show on the sign-in page" description="People with a linked account can sign in with it." checked={v.enabled} onCheckedChange={set("enabled")} />
          <SwitchRow
            title="Allow new accounts"
            description="Off: only people who already have an account (or were invited) can sign in. Existing users are linked by their verified email."
            checked={v.allowSignUp}
            onCheckedChange={set("allowSignUp")}
          />
          {v.allowSignUp && (
            <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface-2 p-4">
              <Field label="Allowed email domains" optional description="Comma separated, like example.com. Empty allows any email.">
                <Input value={v.allowedDomains} onChange={(e) => set("allowedDomains")(e.target.value)} placeholder="example.com" className="font-mono text-[13px]" />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <Field label="New accounts join" description="Without one, new people see an empty dashboard until someone invites them.">
                  <Select
                    value={v.defaultOrganizationId || "none"}
                    onValueChange={(x) => set("defaultOrganizationId")(x === "none" ? "" : x)}
                    options={[{ value: "none", label: "No organization" }, ...organizations.map((o) => ({ value: o.id, label: o.name }))]}
                  />
                </Field>
                <Field label="As">
                  <Select
                    value={v.defaultRole}
                    onValueChange={set("defaultRole")}
                    disabled={!v.defaultOrganizationId}
                    options={[
                      { value: "member", label: "Member" },
                      { value: "admin", label: "Admin" },
                    ]}
                  />
                </Field>
              </div>
            </div>
          )}
          {c?.enabled && c.hasSecret && (
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <CircleCheck className="size-3.5 text-ok" /> To test, open the sign-in page in a private window and use the {titles[row.id]} button.
            </p>
          )}
        </>
      )}
    </SettingsCard>
  );
}
