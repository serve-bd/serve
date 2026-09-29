"use client";

import * as React from "react";
import { AlertTriangle, ArrowUpRight, Trash2 } from "lucide-react";
import { SsoMark } from "@/components/sso-mark";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
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

type Org = { id: string; name: string; roles: { id: string; name: string }[] };

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
  organizations: Org[];
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

      <Card>
        <CardHeader title="Providers" description="Let people sign in with an account they already have." />
        <div className="divide-y divide-line">
          {providers.map((p) => (
            <ProviderItem key={p.id} row={p} organizations={organizations} />
          ))}
        </div>
      </Card>
    </>
  );
}

const consoles: Partial<Record<SsoProviderId, { label: string; href: string }>> = {
  github: { label: "Open GitHub", href: "https://github.com/settings/applications/new" },
  google: { label: "Open Google Cloud", href: "https://console.cloud.google.com/apis/credentials" },
};

const blurb: Record<SsoProviderId, string> = {
  github: "Sign in with a GitHub account.",
  google: "Sign in with a Google or Workspace account.",
  oidc: "Your company login, over OpenID Connect.",
};

/** One provider in the list: logo, status and a button that opens its setup. */
function ProviderItem({ row, organizations }: { row: ProviderRow; organizations: Org[] }) {
  const [open, setOpen] = React.useState(false);
  const c = row.config;
  const on = !!c?.enabled && !!c.hasSecret;
  const domains = c?.allowedOrgs?.length
    ? ` · members of ${c.allowedOrgs.join(", ")}`
    : c?.allowedDomains.length
      ? ` · ${c.allowedDomains.map((d) => `@${d}`).join(", ")} only`
      : "";
  const sub = !c ? blurb[row.id] : on ? `${c.allowSignUp ? "On · new accounts allowed" : "On · existing accounts only"}${domains}` : "Off";
  return (
    <div className="flex items-center gap-3.5 px-5 py-4">
      <span className="flex size-10 flex-none items-center justify-center rounded-xl border border-line bg-surface-2">
        <SsoMark provider={row.id} className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="text-[14px] font-medium text-fg">{row.id === "oidc" && c?.label ? c.label : titles[row.id]}</span>
          {on ? <Badge tone="ok">On</Badge> : c ? <Badge>Off</Badge> : null}
        </span>
        <span className="truncate text-[13px] text-muted">{sub}</span>
      </div>
      <Button size="sm" variant={c ? "secondary" : "primary"} onClick={() => setOpen(true)}>
        {c ? "Configure" : "Set up"}
      </Button>
      <ProviderDialog key={`${open}:${JSON.stringify(c)}`} row={row} organizations={organizations} open={open} onOpenChange={setOpen} />
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="flex gap-3">
      <span className="flex size-6 flex-none items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent">{n}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 pb-1">
        <h3 className="text-[13px] font-medium text-fg">{title}</h3>
        {children}
      </div>
    </section>
  );
}

function ProviderDialog({ row, organizations, open, onOpenChange }: { row: ProviderRow; organizations: Org[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const confirm = useConfirm();
  const c = row.config;
  const [v, setV] = React.useState({
    enabled: c?.enabled ?? true,
    clientId: c?.clientId ?? "",
    clientSecret: "",
    allowSignUp: c?.allowSignUp ?? false,
    allowedDomains: (c?.allowedDomains ?? []).join(", "),
    allowedOrgs: (c?.allowedOrgs ?? []).join(", "),
    defaultOrganizationId: c?.defaultOrganizationId ?? "",
    // One choice for the role: "admin", or a member role (developer, viewer, custom).
    role: c?.defaultRole === "admin" ? "admin" : (c?.defaultRoleId ?? (c?.defaultOrganizationId ? "developer" : "viewer")),
    issuer: c?.issuer ?? "",
    scopes: (c?.scopes ?? []).join(" "),
    label: c?.label ?? "",
  });
  const set =
    <K extends keyof typeof v>(k: K) =>
    (value: (typeof v)[K]) =>
      setV((s) => ({ ...s, [k]: value }));
  const save = useAction(
    () =>
      saveSsoProvider(row.id, {
        enabled: v.enabled,
        clientId: v.clientId,
        clientSecret: v.clientSecret || undefined,
        allowSignUp: v.allowSignUp,
        allowedDomains: list(v.allowedDomains),
        allowedOrgs: row.id === "github" ? list(v.allowedOrgs) : [],
        defaultOrganizationId: v.defaultOrganizationId || null,
        defaultRole: v.role === "admin" ? "admin" : "member",
        defaultRoleId: v.role === "admin" ? null : v.role,
        ...(row.id === "oidc" ? { issuer: v.issuer, scopes: list(v.scopes), label: v.label } : {}),
      }),
    { success: `${titles[row.id]} sign-in saved`, onSuccess: () => onOpenChange(false) },
  );
  const remove = useAction(() => removeSsoProvider(row.id), { success: `${titles[row.id]} sign-in removed`, onSuccess: () => onOpenChange(false) });
  const test = useAction(testOidcIssuer, { refresh: false });
  const ready = !!v.clientId.trim() && (!!v.clientSecret || !!c?.hasSecret) && (row.id !== "oidc" || !!v.issuer.trim());
  const where = consoles[row.id];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save.run();
          }}
        >
          <DialogHeader
            title={
              <span className="flex items-center gap-2.5">
                <SsoMark provider={row.id} className="size-5" /> {titles[row.id]} sign-in
              </span>
            }
            description={help[row.id]}
          />
          <DialogBody className="max-h-[65vh] gap-6 overflow-y-auto">
            <Step n={1} title={row.id === "oidc" ? "Create a web application at your provider" : `Create an OAuth app on ${titles[row.id]}`}>
              {where && (
                <a href={where.href} target="_blank" rel="noreferrer" className={cn(buttonVariants({ size: "sm" }), "w-fit")}>
                  {where.label} <ArrowUpRight />
                </a>
              )}
            </Step>
            <Step n={2} title="Add this callback URL">
              <CopyField value={row.callbackUrl} />
            </Step>
            <Step n={3} title="Paste the app's details">
              {row.id === "oidc" && (
                <Field label="Issuer URL" description="Serve reads its /.well-known/openid-configuration.">
                  <div className="flex gap-2">
                    <Input value={v.issuer} onChange={(e) => set("issuer")(e.target.value)} placeholder="https://login.example.com" className="font-mono text-[13px]" />
                    <Button
                      type="button"
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
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            </Step>

            <div className="flex flex-col gap-4 border-t border-line pt-5">
              <SwitchRow title="Show on the sign-in page" description="People with a linked account can sign in with it." checked={v.enabled} onCheckedChange={set("enabled")} />
              {row.id === "github" && (
                <Field
                  label="Only members of these GitHub organizations"
                  optional
                  description="Comma separated, like acme. Checked on every sign-in; members may also sign up. GitHub asks each person to share their organizations, and an organization with app access restrictions must approve this app first."
                >
                  <Input value={v.allowedOrgs} onChange={(e) => set("allowedOrgs")(e.target.value)} placeholder="acme" className="font-mono text-[13px]" />
                </Field>
              )}
              <Field
                label="Only allow emails from"
                optional
                description="Comma separated, like example.com or *@example.com; subdomains count. Applies to every sign-in and link with this provider. Empty allows any email."
              >
                <Input value={v.allowedDomains} onChange={(e) => set("allowedDomains")(e.target.value)} placeholder="example.com" className="font-mono text-[13px]" />
              </Field>
              {row.id === "github" && list(v.allowedOrgs).length > 0 ? (
                <p className="text-xs leading-relaxed text-muted">New accounts: members of {list(v.allowedOrgs).join(", ")} get one on their first sign-in.</p>
              ) : (
                <SwitchRow
                  title="Allow new accounts"
                  description="Off: only people who already have an account, or were invited, can sign in."
                  checked={v.allowSignUp}
                  onCheckedChange={set("allowSignUp")}
                />
              )}
              {(v.allowSignUp || (row.id === "github" && list(v.allowedOrgs).length > 0)) && (
                <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface-2 p-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
                    <Field label="New accounts join">
                      <Select
                        value={v.defaultOrganizationId || "none"}
                        onValueChange={(x) => setV((s) => ({ ...s, defaultOrganizationId: x === "none" ? "" : x, role: "viewer" }))}
                        options={[{ value: "none", label: "No organization" }, ...organizations.map((o) => ({ value: o.id, label: o.name }))]}
                      />
                    </Field>
                    <Field label="As">
                      <Select
                        value={v.role}
                        onValueChange={set("role")}
                        disabled={!v.defaultOrganizationId}
                        options={(organizations.find((o) => o.id === v.defaultOrganizationId)?.roles ?? [{ id: "developer", name: "Developer" }]).map((r) => ({
                          value: r.id,
                          label: r.name,
                        }))}
                      />
                    </Field>
                  </div>
                </div>
              )}
              {row.id === "oidc" && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Button text" optional>
                    <Input value={v.label} onChange={(e) => set("label")(e.target.value)} placeholder="Sign in with SSO" maxLength={60} />
                  </Field>
                  <Field label="Scopes" optional description="Default: openid email profile.">
                    <Input value={v.scopes} onChange={(e) => set("scopes")(e.target.value)} placeholder="openid email profile" className="font-mono text-[13px]" />
                  </Field>
                </div>
              )}
            </div>
          </DialogBody>
          <DialogFooter className="sm:justify-between">
            {c ? (
              <Button
                type="button"
                size="sm"
                variant="danger-ghost"
                loading={remove.pending}
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Remove ${titles[row.id]} sign-in?`,
                      description: "People who only sign in with it lose access until they use another method. Linked accounts stay, so setting it up again restores them.",
                      confirmLabel: "Remove",
                      danger: true,
                    })
                  )
                    remove.run();
                }}
              >
                <Trash2 /> Remove
              </Button>
            ) : (
              <span />
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <DialogClose render={<Button type="button" variant="ghost" size="sm" />}>Cancel</DialogClose>
              <Button type="submit" variant="primary" size="sm" loading={save.pending} disabled={!ready}>
                Save
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
