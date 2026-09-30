"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Check, FolderGit2, KeyRound, Link2, RefreshCw, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardHeader, CopyField, TimeAgo } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import { createGitOAuthApp, deleteGitOAuthApp, startGitOAuth } from "@/server/actions/integrations";
import { ProductName } from "@/components/brand";

export type OAuthProvider = "gitlab" | "gitea" | "bitbucket";

export type OAuthAppRow = {
  id: string;
  provider: OAuthProvider;
  name: string;
  baseUrl: string | null;
  groupPath: string | null;
  createdAt: string;
  connection: { login: string | null; connectedAt: string } | null;
};

export type OAuthBase = { url: string; ok: boolean; error?: string };

const names: Record<OAuthProvider, string> = { gitlab: "GitLab", gitea: "Gitea / Forgejo", bitbucket: "Bitbucket" };
const colors: Record<OAuthProvider, string> = { gitlab: "#fc6d26", gitea: "#609926", bitbucket: "#2684ff" };
const scopes: Record<OAuthProvider, string> = {
  gitlab: "api read_user read_repository",
  gitea: "read:user write:repository",
  bitbucket: "account repository webhook pullrequest",
};

function ProviderIcon({ provider }: { provider: OAuthProvider }) {
  return (
    <span className="flex size-9 flex-none items-center justify-center rounded-[10px] text-white" style={{ background: colors[provider] }} aria-hidden>
      <FolderGit2 className="size-4" />
    </span>
  );
}

const host = (url: string | null, provider: OAuthProvider) =>
  (url ?? (provider === "gitlab" ? "https://gitlab.com" : provider === "bitbucket" ? "https://bitbucket.org" : "")).replace(/^https?:\/\//, "");

/* --------------------------------- List ---------------------------------- */

export function OAuthApps({ apps, isAdmin }: { apps: OAuthAppRow[]; isAdmin: boolean }) {
  const confirm = useConfirm();
  const connect = useAction(startGitOAuth, { refresh: false, onSuccess: (url) => (window.location.href = url) });
  const remove = useAction(deleteGitOAuthApp, { success: "OAuth app removed" });
  if (!apps.length) return null;
  return (
    <Card className="overflow-hidden">
      <CardHeader title="OAuth apps" description="GitLab, Gitea and Bitbucket connected through your own OAuth application. Tokens refresh automatically." />
      <div className="divide-y divide-line">
        {apps.map((a) => (
          <div key={a.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
            <ProviderIcon provider={a.provider} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-fg">
                {a.name}
                {a.connection ? (
                  <Badge tone="ok">
                    <Check /> Connected{a.connection.login ? ` as ${a.connection.login}` : ""}
                  </Badge>
                ) : (
                  <Badge tone="warn">Not connected</Badge>
                )}
              </span>
              <span className="truncate text-xs text-muted">
                {names[a.provider]} · <span className="font-mono">{host(a.baseUrl, a.provider)}</span>
                {a.groupPath && <> · group {a.groupPath}</>} · added <TimeAgo date={a.createdAt} />
              </span>
            </div>
            {isAdmin && (
              <>
                <Button size="sm" variant={a.connection ? "secondary" : "primary"} onClick={() => connect.run(a.id)} loading={connect.pending}>
                  {a.connection ? <RefreshCw /> : <Link2 />} {a.connection ? "Reconnect" : "Connect"}
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Remove"
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Remove ${a.name}?`,
                        description: "Services using this connection can no longer pull their repository. Delete the application on the provider as well to revoke it.",
                        confirmLabel: "Remove",
                        danger: true,
                      })
                    )
                      remove.run(a.id);
                  }}
                >
                  <Trash2 />
                </Button>
              </>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ----------------------------- Method choice ----------------------------- */

function MethodOption({ icon, title, body, badge, onClick }: { icon: React.ReactNode; title: string; body: string; badge?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-3 rounded-xl border border-line px-4 py-3.5 text-left transition-colors hover:border-line-strong hover:bg-hover/40"
    >
      <span className="mt-0.5 flex size-8 flex-none items-center justify-center rounded-lg bg-accent-soft text-accent [&_svg]:size-4">{icon}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-[14px] font-medium text-fg">
          {title}
          {badge && <Badge tone="info">{badge}</Badge>}
        </span>
        <span className="text-[13px] leading-relaxed text-muted">{body}</span>
      </span>
    </button>
  );
}

export function MethodDialog({ provider, onClose, onOAuth, onToken }: { provider: OAuthProvider | null; onClose: () => void; onOAuth: () => void; onToken: () => void }) {
  return (
    <Dialog open={!!provider} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title={`Connect ${provider ? names[provider] : ""}`} description="Both options list your repositories and set up deploy on push." />
        <DialogBody>
          <MethodOption
            icon={<ShieldCheck />}
            title="Connect with OAuth"
            badge="Recommended"
            body="Create an OAuth application once, then connect with one click. No personal token to paste or rotate."
            onClick={onOAuth}
          />
          <MethodOption icon={<KeyRound />} title="Use an access token" body="Paste a personal or project access token. Quick, but it expires with the token." onClick={onToken} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------ Setup dialog ----------------------------- */

function setupUrl(provider: OAuthProvider, baseUrl: string) {
  const b = baseUrl.replace(/\/$/, "");
  if (provider === "gitlab") return `${b || "https://gitlab.com"}/-/user_settings/applications`;
  if (provider === "gitea") return b ? `${b}/user/settings/applications` : null;
  return "https://bitbucket.org/account/workspaces/";
}

function Step({ n, title, active, done, children }: { n: number; title: string; active: boolean; done: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span
        className={cn(
          "flex size-6 flex-none items-center justify-center rounded-full text-xs font-semibold",
          done ? "bg-ok text-white" : active ? "bg-accent text-white" : "bg-surface-2 text-muted",
        )}
      >
        {done ? <Check className="size-3.5" /> : n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <span className={cn("pt-0.5 text-[14px] font-medium", active || done ? "text-fg" : "text-muted")}>{title}</span>
        {active && children}
      </div>
    </div>
  );
}

export function OAuthSetupDialog({ provider, base, isInstanceAdmin, onClose }: { provider: OAuthProvider | null; base: OAuthBase; isInstanceAdmin: boolean; onClose: () => void }) {
  const [step, setStep] = React.useState<1 | 2>(1);
  const [form, setForm] = React.useState({ name: "", baseUrl: "", clientId: "", clientSecret: "", groupPath: "" });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const connect = useAction(startGitOAuth, { refresh: false, onSuccess: (url) => (window.location.href = url) });
  const create = useAction(() => createGitOAuthApp({ provider: provider!, ...form, name: form.name || names[provider!] }), {
    success: "OAuth app saved. Opening the provider to connect…",
    onSuccess: (d) => void connect.run(d.id),
  });
  // Reset when opened for another provider.
  const [shown, setShown] = React.useState(provider);
  if (provider !== shown) {
    setShown(provider);
    setStep(1);
    setForm({ name: "", baseUrl: "", clientId: "", clientSecret: "", groupPath: "" });
  }
  if (!provider) return null;
  const redirect = `${base.url.replace(/\/$/, "")}/api/git/oauth/${provider}/callback`;
  const appPage = setupUrl(provider, form.baseUrl);
  const selfHosted = provider !== "bitbucket";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <form
          method="post"
          onSubmit={(e) => {
            e.preventDefault();
            if (step === 1) setStep(2);
            else void create.run();
          }}
        >
          <DialogHeader title={`Connect ${names[provider]} with OAuth`} description="Two steps. The application stays under your control on the provider." />
          <DialogBody className="gap-5">
            {!base.ok && (
              <p className="flex gap-2 rounded-lg border border-warn/25 bg-warn-soft px-3 py-2.5 text-[13px] text-fg-2">
                <TriangleAlert className="mt-0.5 size-4 flex-none text-warn" />
                <span>
                  {base.error}{" "}
                  {isInstanceAdmin ? (
                    <Link href="/settings/dashboard" className="font-medium text-accent hover:underline">
                      Open Settings → Dashboard
                    </Link>
                  ) : (
                    "An instance admin can change it."
                  )}
                </span>
              </p>
            )}
            <Step n={1} title="Create an OAuth application" active={step === 1} done={step === 2}>
              {selfHosted && (
                <Field
                  label="Server URL"
                  optional={provider === "gitlab"}
                  description={provider === "gitlab" ? "Leave empty for gitlab.com." : "The address of your Gitea or Forgejo server."}
                >
                  <Input
                    value={form.baseUrl}
                    onChange={set("baseUrl")}
                    required={provider === "gitea"}
                    placeholder={provider === "gitlab" ? "https://gitlab.com" : "https://git.example.com"}
                  />
                </Field>
              )}
              <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[13px] leading-relaxed text-fg-2">
                <li>
                  {appPage ? (
                    <a href={appPage} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
                      {provider === "bitbucket" ? "Open your workspace → Settings → OAuth consumers" : `Open ${names[provider]} → Applications`}
                      <ArrowUpRight className="size-3.5" />
                    </a>
                  ) : (
                    "Enter the server URL above to get the link."
                  )}{" "}
                  {provider === "gitlab" && <span className="text-muted">(older versions: Preferences → Applications)</span>}
                </li>
                <li>
                  Create an application named <ProductName />
                  {provider === "gitlab" ? ", keep Confidential checked" : ""}.
                </li>
                <li>Use this {provider === "bitbucket" ? "callback URL" : "redirect URI"}:</li>
              </ol>
              <CopyField value={redirect} />
              <p className="text-[13px] text-fg-2">
                {provider === "bitbucket" ? "Permissions:" : "Scopes:"}{" "}
                <span className="text-muted">({provider === "bitbucket" ? "Account read, Repositories read, Webhooks read and write, Pull requests read" : "select these"})</span>
              </p>
              <CopyField value={scopes[provider]} />
            </Step>
            <Step n={2} title="Enter the application credentials" active={step === 2} done={false}>
              <Field label="Name" optional>
                <Input value={form.name} onChange={set("name")} placeholder={names[provider]} />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={provider === "bitbucket" ? "Key" : "Application ID"}>
                  <Input value={form.clientId} onChange={set("clientId")} required className="font-mono text-[13px]" autoComplete="off" />
                </Field>
                <Field label="Secret">
                  <Input type="password" value={form.clientSecret} onChange={set("clientSecret")} required autoComplete="new-password" />
                </Field>
              </div>
              {provider === "gitlab" && (
                <Field label="Group" optional description="Only list repositories of this group and its subgroups, e.g. my-company.">
                  <Input value={form.groupPath} onChange={set("groupPath")} placeholder="my-company" />
                </Field>
              )}
            </Step>
          </DialogBody>
          <DialogFooter>
            {step === 2 ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setStep(1)}>
                Back
              </Button>
            ) : (
              <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            )}
            <Button type="submit" variant="primary" size="sm" loading={create.pending || connect.pending} disabled={!base.ok}>
              {step === 1 ? "I created it" : "Save and connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
