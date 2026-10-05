"use client";

import * as React from "react";
import { AlertTriangle, ArrowUpRight, Mail, Plus, Trash2 } from "lucide-react";
import { SsoMark } from "@/components/sso-mark";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ui/confirm";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Badge, Card, CardBody, CardHeader, CopyField } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { Switch, SwitchRow } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "@/components/ui/toast";
import { useAction } from "@/hooks/use-action";
import { removeSsoProvider, saveSsoProvider, setPasswordLogin, setSsoProviderEnabled, testOidcIssuer } from "@/server/actions/sign-in";
import { displayName, MICROSOFT_SHARED_TENANTS, OIDC_PRESETS, type ProviderView, providerNames, type SsoProviderId } from "@/server/sso/config";

type Org = { id: string; name: string; roles: { id: string; name: string }[] };

type ProviderRow = { id: SsoProviderId; callbackUrl: string; config: ProviderView | null; people: number };

const titles: Record<SsoProviderId, string> = providerNames;

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
  microsoft: (
    <>
      In the Microsoft Entra admin center open <b>App registrations → New registration</b>. Choose <b>Web</b> as the platform, paste the callback URL below as the redirect URI,
      then add a secret under <b>Certificates &amp; secrets</b>. The <b>User.Read</b> permission it starts with is enough.
    </>
  ),
  gitlab: (
    <>
      On GitLab open <b>Preferences → Applications → Add new application</b> (or a group&apos;s or the admin area&apos;s applications). Paste the callback URL below, keep it{" "}
      <b>Confidential</b>, and tick only the <b>read_user</b> scope.
    </>
  ),
  bitbucket: (
    <>
      In Bitbucket open your workspace&apos;s <b>Settings → OAuth consumers → Add consumer</b>. Paste the callback URL below, tick <b>This is a private consumer</b>, and give it
      only the <b>Account: Email</b> and <b>Account: Read</b> permissions.
    </>
  ),
  oidc: (
    <>
      For your company login, like Keycloak, Authentik, Okta, Auth0 or Zitadel. Create an OpenID Connect web application there, add the callback URL below as a redirect URI, and
      paste its issuer URL, client ID and secret.
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
  passwordPeople,
  providers,
  organizations,
  httpsWarning,
}: {
  passwordEnabled: boolean;
  forcedPassword: boolean;
  /** People with a password. */
  passwordPeople: number;
  providers: ProviderRow[];
  organizations: Org[];
  httpsWarning: boolean;
}) {
  const togglePassword = useAction((on: boolean, signOut?: boolean) => setPasswordLogin(on, signOut), {
    onSuccess: (d) => toast.success(signedOutText("Password sign-in updated", d.signedOut)),
  });
  const [passwordOff, setPasswordOff] = React.useState(false);
  const active = providers.filter((p) => p.config?.enabled && p.config.hasSecret);

  return (
    <Card>
      <CardHeader title="Sign-in methods" description="How people sign in to this dashboard. Changes apply at once; nobody needs to restart anything." />
      <div className="divide-y divide-line">
        {/* Email and password: the first way in, like a provider that is always set up. */}
        <div className="flex items-center gap-3.5 px-5 py-4">
          <span className="flex size-10 flex-none items-center justify-center rounded-xl border border-line bg-surface-2">
            <Mail className="size-5 text-fg-2" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <span className="text-[14px] font-medium text-fg">Email and password</span>
              {passwordEnabled || forcedPassword ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>}
            </span>
            <span className="text-[13px] text-muted">
              {!active.length
                ? "The only way in until a provider below is on."
                : passwordEnabled
                  ? "Turn off to allow only the providers below. A Root admin must have linked one of them on their Account page first."
                  : "Only the providers below can sign in."}
            </span>
          </div>
          <Switch
            checked={passwordEnabled}
            disabled={togglePassword.pending || (passwordEnabled && !active.length)}
            onCheckedChange={(on) => (on ? togglePassword.run(true) : setPasswordOff(true))}
            aria-label="Email and password sign-in on or off"
          />
        </div>
        {providers.map((p) => (
          <ProviderItem key={p.id} row={p} organizations={organizations} />
        ))}
      </div>
      {(forcedPassword || (!passwordEnabled && !forcedPassword) || httpsWarning) && (
        <CardBody className="flex flex-col gap-3 border-t border-line py-4">
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
              The dashboard has no HTTPS domain yet. Most providers only accept https callback URLs; set one in Settings → General.
            </p>
          )}
        </CardBody>
      )}
      <TurnOffDialog
        open={passwordOff}
        onOpenChange={setPasswordOff}
        title="Turn off password sign-in?"
        description={
          forcedPassword
            ? "SERVE_ALLOW_PASSWORD_LOGIN keeps password sign-in on while it is set. This setting takes effect once you remove it."
            : "Nobody can sign in with a password until you turn it on again. The saved passwords stay."
        }
        people={passwordPeople}
        method="a password"
        signOutPossible={!forcedPassword}
        onConfirm={(signOut) => togglePassword.run(false, signOut)}
      />
    </Card>
  );
}

const signedOutText = (text: string, n: number) => (n ? `${text}. ${n} ${n === 1 ? "person was" : "people were"} signed out.` : text);

/** Confirms turning a sign-in method off, with the choice to end the sessions of the people who use it. */
function TurnOffDialog({
  open,
  onOpenChange,
  title,
  description,
  people,
  method,
  signOutPossible = true,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  people: number;
  method: string;
  signOutPossible?: boolean;
  onConfirm: (signOut: boolean) => void;
}) {
  const [signOut, setSignOut] = React.useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setSignOut(false);
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader title={title} description={description} />
        <DialogBody>
          {signOutPossible && people > 0 ? (
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line px-3.5 py-3 hover:bg-hover">
              <Checkbox className="mt-0.5" checked={signOut} onCheckedChange={(v) => setSignOut(!!v)} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13px] font-medium text-fg">Also sign out everyone who has {method}</span>
                <span className="text-xs leading-relaxed text-muted">
                  {people} {people === 1 ? "person has" : "people have"} one. Someone who also has another sign-in method is signed out too, and signs in again with it. You stay
                  signed in.
                </span>
              </span>
            </label>
          ) : (
            <p className="text-[13px] text-muted">People who are signed in now stay signed in.</p>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              onConfirm(signOut);
              setSignOut(false);
              onOpenChange(false);
            }}
          >
            Turn off
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const consoles: Partial<Record<SsoProviderId, { label: string; href: string }>> = {
  github: { label: "Open GitHub", href: "https://github.com/settings/applications/new" },
  google: { label: "Open Google Cloud", href: "https://console.cloud.google.com/apis/credentials" },
  microsoft: { label: "Open Microsoft Entra", href: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" },
  gitlab: { label: "Open GitLab", href: "https://gitlab.com/-/user_settings/applications" },
  bitbucket: { label: "Open Bitbucket", href: "https://bitbucket.org/account/workspaces/" },
};

const blurb: Record<SsoProviderId, string> = {
  github: "Sign in with a GitHub account.",
  google: "Sign in with a Google or Workspace account.",
  microsoft: "Sign in with a Microsoft work or school account (Entra ID).",
  gitlab: "Sign in with GitLab.com or a GitLab of your own.",
  bitbucket: "Sign in with a Bitbucket account.",
  oidc: "Your company login: Keycloak, Authentik, Okta, Auth0 and more.",
};

/** Where to start on a GitLab server, gitlab.com when none is set. */
const gitlabApps = (server: string) => `${(server.trim() || "https://gitlab.com").replace(/\/+$/, "")}/-/user_settings/applications`;

/** One provider in the list: logo, status and a button that opens its setup. */
function ProviderItem({ row, organizations }: { row: ProviderRow; organizations: Org[] }) {
  const [open, setOpen] = React.useState(false);
  const [turningOff, setTurningOff] = React.useState(false);
  const toggle = useAction((on: boolean, signOut?: boolean) => setSsoProviderEnabled(row.id, on, signOut), {
    onSuccess: (d) => toast.success(signedOutText(`${titles[row.id]} sign-in updated`, d.signedOut)),
  });
  const c = row.config;
  const on = !!c?.enabled && !!c.hasSecret;
  const domains = c?.allowedOrgs?.length
    ? ` · members of ${c.allowedOrgs.join(", ")} only`
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
          <span className="text-[14px] font-medium text-fg">{row.id === "oidc" && c ? displayName(row.id, { ...c, clientSecret: "" }) : titles[row.id]}</span>
          {on ? <Badge tone="ok">On</Badge> : c ? <Badge>Off</Badge> : null}
        </span>
        <span className="text-[13px] text-muted sm:truncate">{sub}</span>
      </div>
      {c?.hasSecret && (
        <Switch
          checked={c.enabled}
          disabled={toggle.pending}
          onCheckedChange={(v) => (v ? toggle.run(true) : setTurningOff(true))}
          aria-label={`${titles[row.id]} sign-in on or off`}
        />
      )}
      <Button size="sm" variant={c ? "secondary" : "primary"} onClick={() => setOpen(true)}>
        {c ? "Configure" : "Set up"}
      </Button>
      <TurnOffDialog
        open={turningOff}
        onOpenChange={setTurningOff}
        title={`Turn off ${titles[row.id]} sign-in?`}
        description="It disappears from the sign-in page, and nobody can sign in with it until you turn it on again. Its settings stay."
        people={row.people}
        method={`a linked ${titles[row.id]} account`}
        onConfirm={(signOut) => toggle.run(false, signOut)}
      />
      {/* Remounted on open, so the form starts from the stored settings; live updates while it is open keep what was typed. */}
      <ProviderDialog key={`${row.id}:${open}`} row={row} organizations={organizations} open={open} onOpenChange={setOpen} />
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
    // One row per GitHub organization: its members join an organization with a role.
    githubOrgs: (c?.githubOrgs?.length
      ? c.githubOrgs
      : (c?.allowedOrgs ?? []).map((org) => ({ org, organizationId: c?.defaultOrganizationId ?? null, role: c?.defaultRole ?? "member", roleId: c?.defaultRoleId ?? null }))
    ).map((r) => ({ org: r.org, organizationId: r.organizationId ?? "", role: r.role === "admin" ? "admin" : (r.roleId ?? "developer") })),
    defaultOrganizationId: c?.defaultOrganizationId ?? "",
    // One choice for the role: "admin", or a member role (developer, viewer, custom).
    role: c?.defaultRole === "admin" ? "admin" : (c?.defaultRoleId ?? (c?.defaultOrganizationId ? "developer" : "viewer")),
    issuer: c?.issuer ?? "",
    scopes: (c?.scopes ?? []).join(" "),
    label: c?.label ?? "",
    tenantId: c?.tenantId ?? "",
    preset: c?.preset ?? "",
  });
  // Microsoft without one named organization: its emails cannot be trusted for new accounts or domain rules.
  const sharedTenant = row.id === "microsoft" && (!v.tenantId.trim() || MICROSOFT_SHARED_TENANTS.includes(v.tenantId.trim().toLowerCase()));
  const preset = OIDC_PRESETS.find((x) => x.id === v.preset);
  const set =
    <K extends keyof typeof v>(k: K) =>
    (value: (typeof v)[K]) =>
      setV((s) => ({ ...s, [k]: value }));
  const rules = v.githubOrgs.filter((r) => r.org.trim());
  const hasRules = row.id === "github" && rules.length > 0;
  const setRule = (i: number, patch: Partial<(typeof v.githubOrgs)[number]>) => setV((s) => ({ ...s, githubOrgs: s.githubOrgs.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const save = useAction(
    () =>
      saveSsoProvider(row.id, {
        enabled: v.enabled,
        clientId: v.clientId,
        clientSecret: v.clientSecret || undefined,
        allowSignUp: v.allowSignUp && !sharedTenant,
        allowedDomains: sharedTenant ? [] : list(v.allowedDomains),
        allowedOrgs: [],
        githubOrgs:
          row.id === "github"
            ? rules.map((r) => ({
                org: r.org,
                organizationId: r.organizationId || null,
                role: r.role === "admin" ? ("admin" as const) : ("member" as const),
                roleId: r.role === "admin" ? null : r.role,
              }))
            : undefined,
        defaultOrganizationId: v.defaultOrganizationId || null,
        defaultRole: v.role === "admin" ? "admin" : "member",
        defaultRoleId: v.role === "admin" ? null : v.role,
        ...(row.id === "oidc"
          ? { issuer: v.issuer, scopes: list(v.scopes), label: v.label, preset: (v.preset || undefined) as (typeof OIDC_PRESETS)[number]["id"] | undefined }
          : {}),
        ...(row.id === "gitlab" ? { issuer: v.issuer.trim() } : {}),
        ...(row.id === "microsoft" ? { tenantId: v.tenantId.trim() || undefined } : {}),
      }),
    { onSuccess: () => onOpenChange(false) },
  );
  const remove = useAction(() => removeSsoProvider(row.id), { onSuccess: () => onOpenChange(false) });
  const test = useAction(testOidcIssuer, { refresh: false });
  const ready = !!v.clientId.trim() && (!!v.clientSecret || !!c?.hasSecret) && (row.id !== "oidc" || !!v.issuer.trim());
  const where = row.id === "gitlab" ? { label: "Open GitLab", href: gitlabApps(v.issuer) } : consoles[row.id];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <form
          method="post"
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
              {row.id === "oidc" && (
                <Field label="Provider" description="Picks the right hints. Any provider that speaks OpenID Connect works.">
                  <Select
                    value={v.preset || "other"}
                    onValueChange={(x) => set("preset")(x === "other" ? "" : x)}
                    options={[...OIDC_PRESETS.map((x) => ({ value: x.id, label: x.name })), { value: "other", label: "Another provider" }]}
                  />
                </Field>
              )}
              {row.id === "gitlab" && (
                <Field label="GitLab server" optional description="For a GitLab of your own. Empty: gitlab.com.">
                  <Input value={v.issuer} onChange={(e) => set("issuer")(e.target.value)} placeholder="https://gitlab.example.com" className="font-mono text-[13px]" />
                </Field>
              )}
              <a
                href={`https://serve.bd/docs/sign-in#${row.id === "oidc" ? (preset ? preset.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "openid-connect") : row.id}`}
                target="_blank"
                rel="noreferrer"
                className="w-fit text-[13px] text-accent hover:underline"
              >
                Step-by-step guide for {row.id === "oidc" ? (preset?.name ?? "OpenID Connect") : titles[row.id]}
              </a>
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
                <Field label="Issuer URL" description="Its /.well-known/openid-configuration is read.">
                  <div className="flex gap-2">
                    <Input
                      value={v.issuer}
                      onChange={(e) => set("issuer")(e.target.value)}
                      placeholder={preset?.issuer ?? "https://login.example.com"}
                      className="font-mono text-[13px]"
                    />
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
              {row.id === "microsoft" && (
                <Field
                  label="Organization (tenant ID)"
                  optional
                  description="From the app's Overview page. Only that organization's people can sign in. Empty: any work or school account, for people who already have an account here."
                >
                  <Input value={v.tenantId} onChange={(e) => set("tenantId")(e.target.value)} placeholder="1b2c3d4e-5f6a-…" className="font-mono text-[13px]" />
                </Field>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={row.id === "microsoft" ? "Application (client) ID" : row.id === "bitbucket" ? "Key" : "Client ID"}>
                  <Input value={v.clientId} onChange={(e) => set("clientId")(e.target.value)} className="font-mono text-[13px]" autoComplete="off" />
                </Field>
                <Field
                  label={row.id === "bitbucket" ? "Secret" : row.id === "microsoft" ? "Client secret value" : "Client secret"}
                  description={c?.hasSecret ? "Saved. Leave empty to keep it." : undefined}
                >
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
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[13px] font-medium text-fg">GitHub organizations</p>
                      <p className="text-xs leading-relaxed text-muted">
                        Only their members can sign in, and they get an account on first sign-in. Each sign-in adds them to the organization you pick, with its role. None: anyone
                        with an account here can sign in.
                      </p>
                    </div>
                    <Button type="button" size="xs" onClick={() => setV((s) => ({ ...s, githubOrgs: [...s.githubOrgs, { org: "", organizationId: "", role: "viewer" }] }))}>
                      <Plus /> Add
                    </Button>
                  </div>
                  {v.githubOrgs.map((r, i) => (
                    <div
                      key={i}
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-xl border border-line bg-surface-2 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_9rem_auto]"
                    >
                      <Input
                        value={r.org}
                        onChange={(e) => setRule(i, { org: e.target.value })}
                        placeholder="GitHub organization, like acme"
                        className="font-mono text-[13px]"
                        aria-label="GitHub organization"
                        autoFocus={!r.org && i === v.githubOrgs.length - 1}
                      />
                      <Button
                        type="button"
                        size="xs"
                        variant="danger-ghost"
                        className="sm:order-last"
                        aria-label="Remove GitHub organization"
                        onClick={() => setV((s) => ({ ...s, githubOrgs: s.githubOrgs.filter((_, j) => j !== i) }))}
                      >
                        <Trash2 />
                      </Button>
                      <Select
                        value={r.organizationId || "none"}
                        onValueChange={(x) => setRule(i, { organizationId: x === "none" ? "" : x, role: "viewer" })}
                        options={[{ value: "none", label: "Sign in only" }, ...organizations.map((o) => ({ value: o.id, label: `Join ${o.name}` }))]}
                        aria-label="Organization in this dashboard"
                      />
                      <Select
                        value={r.role}
                        onValueChange={(x) => setRule(i, { role: x })}
                        disabled={!r.organizationId}
                        options={(organizations.find((o) => o.id === r.organizationId)?.roles ?? [{ id: "viewer", name: "Viewer" }]).map((x) => ({ value: x.id, label: x.name }))}
                        aria-label="Role"
                      />
                    </div>
                  ))}
                  <p className="text-xs leading-relaxed text-muted">
                    GitHub asks each person to share their organizations. Private members of an organization that restricts third-party apps are only seen once an owner approves
                    this app; public members always are.
                  </p>
                </div>
              )}
              {sharedTenant && (
                <p className="flex gap-2 rounded-xl border border-warn/30 bg-warn-soft/40 p-3 text-xs leading-relaxed text-fg-2">
                  <AlertTriangle className="mt-0.5 size-3.5 flex-none text-warn" />
                  Without a tenant ID, only people who already have an account here can sign in, after linking Microsoft on their Account page. Microsoft accounts can carry any
                  email their organization lets them set, so new accounts and email rules need one named organization.
                </p>
              )}
              {!sharedTenant && (
                <Field
                  label="Only allow emails from"
                  optional
                  description="Comma separated, like example.com or *@example.com; subdomains count. Applies to every sign-in and link with this provider. Empty allows any email."
                >
                  <Input value={v.allowedDomains} onChange={(e) => set("allowedDomains")(e.target.value)} placeholder="example.com" className="font-mono text-[13px]" />
                </Field>
              )}
              {!hasRules && !sharedTenant && (
                <SwitchRow
                  title="Allow new accounts"
                  description="Off: only people who already have an account, or were invited, can sign in."
                  checked={v.allowSignUp}
                  onCheckedChange={set("allowSignUp")}
                />
              )}
              {v.allowSignUp && !hasRules && !sharedTenant && (
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
                    <Input
                      value={v.label}
                      onChange={(e) => set("label")(e.target.value)}
                      placeholder={preset ? `Continue with ${preset.name}` : "Sign in with SSO"}
                      maxLength={60}
                    />
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
