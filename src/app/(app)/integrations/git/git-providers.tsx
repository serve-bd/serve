"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@/hooks/use-router";
import { AlertTriangle, ArrowUpRight, Check, ChevronDown, ChevronRight, FolderGit2, KeyRound, Plus, Settings2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardBody, CardHeader, CopyField, TimeAgo } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { useAction } from "@/hooks/use-action";
import { addGitToken, createDeployKey, deleteGitCredential, githubAppInstallUrl, startGithubApp } from "@/server/actions/integrations";
import type { GitProviderType } from "@/server/db/schema";
import { cn } from "@/lib/utils";
import { postManifest } from "@/lib/github";
import { GithubMark } from "@/components/github-mark";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { MethodDialog, OAuthApps, OAuthSetupDialog, type OAuthAppRow, type OAuthBase, type OAuthProvider } from "./oauth-apps";

type Cred = {
  id: string;
  name: string;
  provider: string;
  publicInfo: string | null;
  createdAt: string;
  app: { slug: string; account: string | null; installed: boolean; settingsUrl: string } | null;
};

const providerNames: Record<string, string> = {
  "github-app": "GitHub App",
  github: "GitHub token",
  gitlab: "GitLab",
  gitea: "Gitea",
  bitbucket: "Bitbucket",
  ssh: "SSH deploy key",
};

const tokenHelp: Record<string, string> = {
  github: "Classic token with repo and admin:repo_hook, so the deploy webhook can be added automatically.",
  gitlab: "Preferences → Access tokens with the api scope, so repositories can be read and the deploy webhook added.",
  gitea: "Settings → Applications → Generate token with read:user and write:repository.",
  bitbucket: "Repository or workspace access token with Repositories: read and Webhooks: read and write.",
};

function OwnerOption({ selected, title, body, onSelect }: { selected: boolean; title: string; body: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex flex-1 items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors",
        selected ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong hover:bg-hover/40",
      )}
    >
      <span className={cn("mt-0.5 flex size-4 flex-none items-center justify-center rounded-full border", selected ? "border-accent bg-accent" : "border-line-strong")}>
        {selected && <span className="size-1.5 rounded-full bg-white" />}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-[13px] font-medium text-fg">{title}</span>
        <span className="text-xs text-muted">{body}</span>
      </span>
    </button>
  );
}

function ConnectGithub({ publicUrl, baseUrl, embedded = false }: { publicUrl: boolean; baseUrl: string; embedded?: boolean }) {
  const [ownerType, setOwnerType] = React.useState<"personal" | "organization">("personal");
  const [organization, setOrganization] = React.useState("");
  const [pending, setPending] = React.useState(false);

  async function connect() {
    setPending(true);
    const res = await startGithubApp({ organization: ownerType === "organization" ? organization : undefined });
    if (!res.ok) {
      setPending(false);
      return toast.error(res.error);
    }
    postManifest(res.data.action, res.data.manifest);
  }

  const body = (
    <div id="connect-github" className="flex scroll-mt-6 flex-col gap-5 p-5 sm:p-6">
      <div className="flex items-start gap-4">
        <span className="flex size-10 flex-none items-center justify-center rounded-xl bg-fg text-bg">
          <GithubMark className="size-5" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-[15px] font-semibold text-fg">Connect GitHub</h3>
          <p className="max-w-xl text-[13px] leading-relaxed text-muted">
            A private GitHub App is created for this server. You choose which repositories it can read, and pushes and pull requests deploy automatically.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2" role="radiogroup" aria-label="Install on">
        <span className="text-[13px] font-medium text-fg-2">Install on</span>
        <div className="flex flex-col gap-2 sm:flex-row">
          <OwnerOption selected={ownerType === "personal"} onSelect={() => setOwnerType("personal")} title="Personal account" body="Repositories you own" />
          <OwnerOption selected={ownerType === "organization"} onSelect={() => setOwnerType("organization")} title="GitHub organization" body="You must be an owner" />
        </div>
        {ownerType === "organization" && (
          <Input
            value={organization}
            onChange={(e) => setOrganization(e.target.value)}
            placeholder="Organization name, e.g. acme"
            className="mt-1"
            autoFocus
            aria-label="GitHub organization name"
          />
        )}
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
        {publicUrl ? (
          <p className="text-xs text-muted">You will review the app on GitHub before it is created.</p>
        ) : (
          <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
            <AlertTriangle className="mt-px size-3.5 flex-none text-warn" />
            <span>
              GitHub can&apos;t reach <span className="font-mono text-fg-2">{new URL(baseUrl).host}</span>, so pushes won&apos;t deploy automatically until you set a public
              dashboard domain.
            </span>
          </p>
        )}
        <Button variant="primary" onClick={connect} loading={pending} disabled={ownerType === "organization" && !organization.trim()} className="flex-none">
          <GithubMark className="size-4" /> Continue on GitHub
        </Button>
      </div>
    </div>
  );

  return embedded ? body : <Card>{body}</Card>;
}

type DialogState = {
  tokenOpen: boolean;
  setTokenOpen: (o: boolean) => void;
  keyOpen: boolean;
  setKeyOpen: (o: boolean) => void;
  provider: GitProviderType;
  setProvider: (p: GitProviderType) => void;
};

/** Dialog state lives in GitProviders so the page's Add provider menu can open them too. */
function useProviderDialogs(): DialogState {
  const [tokenOpen, setTokenOpen] = React.useState(false);
  const [keyOpen, setKeyOpen] = React.useState(false);
  const [provider, setProvider] = React.useState<GitProviderType>("gitlab");
  return { tokenOpen, setTokenOpen, keyOpen, setKeyOpen, provider, setProvider };
}

function OtherProviders({ isAdmin, dialogs }: { isAdmin: boolean; dialogs: DialogState }) {
  const { tokenOpen, setTokenOpen, keyOpen, setKeyOpen, provider, setProvider } = dialogs;
  const [name, setName] = React.useState("");
  const [token, setToken] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [keyName, setKeyName] = React.useState("");
  const [publicKey, setPublicKey] = React.useState<string | null>(null);
  const add = useAction(() => addGitToken({ provider, name, token, baseUrl }), {
    success: (d) => (d.warning ? `Connected as ${d.login}. ${d.warning}` : `Connected as ${d.login}`),
    onSuccess: () => {
      setTokenOpen(false);
      setToken("");
      setName("");
    },
  });
  const key = useAction(() => createDeployKey(keyName), { onSuccess: (d) => setPublicKey(d.publicKey) });
  const [wasOpen, setWasOpen] = React.useState(keyOpen);
  if (keyOpen !== wasOpen) {
    setWasOpen(keyOpen);
    if (keyOpen) {
      setPublicKey(null);
      setKeyName("");
    }
  }

  if (!isAdmin) return null;
  return (
    <>
      <Card>
        <CardHeader title="Other providers" description="For OAuth, use Add provider. Access tokens and SSH deploy keys work with any Git host." />
        <div className="divide-y divide-line">
          <button type="button" onClick={() => setTokenOpen(true)} className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-hover/50">
            <FolderGit2 className="size-4 text-muted" />
            <span className="flex flex-1 flex-col">
              <span className="text-[13px] font-medium text-fg">Add an access token</span>
              <span className="text-xs text-muted">GitLab, Gitea, Bitbucket, or a GitHub personal token</span>
            </span>
            <ChevronRight className="size-4 text-faint" />
          </button>
          <button type="button" onClick={() => setKeyOpen(true)} className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-hover/50">
            <KeyRound className="size-4 text-muted" />
            <span className="flex flex-1 flex-col">
              <span className="text-[13px] font-medium text-fg">Create an SSH deploy key</span>
              <span className="text-xs text-muted">Read access to one repository on any host</span>
            </span>
            <ChevronRight className="size-4 text-faint" />
          </button>
        </div>
      </Card>

      <Dialog open={tokenOpen} onOpenChange={setTokenOpen}>
        <DialogContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void add.run();
            }}
          >
            <DialogHeader title="Add access token" description={<>The token is checked, then you see the repositories it can read.</>} />
            <DialogBody>
              <Field label="Provider">
                <Select
                  value={provider}
                  onValueChange={(v) => setProvider(v as GitProviderType)}
                  options={["gitlab", "gitea", "bitbucket", "github"].map((p) => ({ value: p, label: providerNames[p] }))}
                />
              </Field>
              {provider !== "bitbucket" && (
                <Field label="Server URL" optional description={provider === "github" ? "Only for GitHub Enterprise Server." : "Leave empty for the hosted service."}>
                  <Input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={provider === "gitea" ? "https://git.example.com" : "https://gitlab.example.com"}
                  />
                </Field>
              )}
              <Field label="Token" description={tokenHelp[provider]}>
                <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} required className="font-mono" autoComplete="off" />
              </Field>
              <Field label="Name" optional>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Company GitLab" />
              </Field>
            </DialogBody>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
              <Button type="submit" variant="primary" size="sm" loading={add.pending}>
                Connect
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={keyOpen} onOpenChange={setKeyOpen}>
        <DialogContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!publicKey) void key.run();
              else setKeyOpen(false);
            }}
          >
            <DialogHeader title="Create SSH deploy key" description="A key pair is generated on the server. Add the public key to your repository with read access." />
            <DialogBody>
              {publicKey ? (
                <Field label="Public key" description="Add it under the repository's deploy keys, then use the SSH clone URL (git@…) for your service.">
                  <CopyField value={publicKey} />
                </Field>
              ) : (
                <Field label="Name">
                  <Input value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="api-server deploy key" required />
                </Field>
              )}
            </DialogBody>
            <DialogFooter>
              <Button type="submit" variant="primary" size="sm" loading={key.pending}>
                {publicKey ? "Done" : "Generate key"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function GitProviders({
  credentials,
  isAdmin,
  baseUrl,
  publicUrl,
  oauthApps,
  oauthBase,
}: {
  credentials: Cred[];
  isAdmin: boolean;
  baseUrl: string;
  publicUrl: boolean;
  oauthApps: OAuthAppRow[];
  oauthBase: OAuthBase;
}) {
  const confirm = useConfirm();
  const router = useRouter();
  const params = useSearchParams();
  const remove = useAction(deleteGitCredential, { success: "Removed" });
  const configure = useAction(githubAppInstallUrl, {
    refresh: false,
    onSuccess: (url) => {
      window.location.href = url;
    },
  });

  const announced = React.useRef(false);
  React.useEffect(() => {
    const connected = params.get("connected");
    const error = params.get("error");
    if ((!connected && !error) || announced.current) return;
    announced.current = true;
    if (connected) toast.success("Connected", `You can now deploy repositories from ${connected}.`);
    if (error) toast.error("GitHub setup did not finish", error);
    router.replace("/integrations/git");
  }, [params, router]);

  const apps = credentials.filter((c) => c.provider === "github-app");
  const others = credentials.filter((c) => c.provider !== "github-app");
  const [connecting, setConnecting] = React.useState(false);
  const dialogs = useProviderDialogs();
  const [method, setMethod] = React.useState<OAuthProvider | null>(null);
  const [oauthSetup, setOauthSetup] = React.useState<OAuthProvider | null>(null);

  return (
    <>
      <PageHeader
        title="Git providers"
        description="Connect GitHub, GitLab, Gitea or Bitbucket to deploy private repositories, with push-to-deploy and pull request previews set up automatically."
        actions={
          isAdmin && (
            <Menu>
              <MenuTrigger render={<Button size="sm" variant="primary" />}>
                <Plus /> Add provider <ChevronDown className="size-3.5 opacity-80" />
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem onClick={() => (apps.length ? setConnecting(true) : document.getElementById("connect-github")?.scrollIntoView({ behavior: "smooth" }))}>
                  <GithubMark /> GitHub
                </MenuItem>
                <MenuSeparator />
                {(["gitlab", "gitea", "bitbucket"] as const).map((p) => (
                  <MenuItem key={p} onClick={() => setMethod(p)}>
                    <FolderGit2 /> {providerNames[p]}
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem onClick={() => dialogs.setKeyOpen(true)}>
                  <KeyRound /> SSH deploy key
                </MenuItem>
              </MenuContent>
            </Menu>
          )
        }
      />
      <PageBody>
        <div className="flex flex-col gap-6">
          {apps.length > 0 && (
            <Card className="overflow-hidden">
              <CardHeader title="GitHub" description="Repositories are read through the GitHub App. Push and pull request events arrive automatically." />
              <div className="divide-y divide-line">
                {apps.map((c) => (
                  <div key={c.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                    <span className="flex size-9 items-center justify-center rounded-[10px] bg-fg text-bg">
                      <GithubMark className="size-4" />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center gap-2 text-[14px] font-medium text-fg">
                        {c.app?.account ?? c.name}
                        {c.app?.installed ? (
                          <Badge tone="ok">
                            <Check /> Installed
                          </Badge>
                        ) : (
                          <Badge tone="warn">Not installed</Badge>
                        )}
                      </span>
                      <span className="text-xs text-muted">
                        App <span className="font-mono">{c.app?.slug}</span> · added <TimeAgo date={c.createdAt} />
                      </span>
                    </div>
                    {isAdmin && (
                      <>
                        <Button size="sm" variant={c.app?.installed ? "secondary" : "primary"} onClick={() => configure.run(c.id)} loading={configure.pending}>
                          <Settings2 /> {c.app?.installed ? "Repository access" : "Finish installation"}
                        </Button>
                        <a
                          href={c.app?.settingsUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-lg p-2 text-muted hover:bg-hover hover:text-fg"
                          aria-label="App settings on GitHub"
                        >
                          <ArrowUpRight className="size-4" />
                        </a>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Remove"
                          onClick={async () => {
                            if (
                              await confirm({
                                title: `Disconnect ${c.app?.account ?? c.name}?`,
                                description: "Services using it can no longer pull their repository. Delete the app on GitHub as well to revoke its access completely.",
                                confirmLabel: "Disconnect",
                                danger: true,
                              })
                            )
                              remove.run(c.id);
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
          )}

          {isAdmin && apps.length === 0 && <ConnectGithub publicUrl={publicUrl} baseUrl={baseUrl} />}

          {others.length > 0 && (
            <Card className="overflow-hidden">
              <CardHeader title="Tokens and keys" />
              <div className="divide-y divide-line">
                {others.map((c) => (
                  <div key={c.id} className="flex items-center gap-3 px-5 py-3.5">
                    <span className="flex size-9 items-center justify-center rounded-[10px] border border-line bg-surface-2">
                      {c.provider === "ssh" ? <KeyRound className="size-4 text-fg-2" /> : <FolderGit2 className="size-4 text-fg-2" />}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[14px] font-medium text-fg">{c.name}</span>
                      <span className="truncate text-xs text-muted">
                        {providerNames[c.provider]}
                        {c.provider !== "ssh" && c.publicInfo && ` · ${c.publicInfo}`} · added <TimeAgo date={c.createdAt} />
                      </span>
                    </div>
                    {c.provider === "ssh" && c.publicInfo && <CopyField value={c.publicInfo} className="hidden max-w-60 md:flex" />}
                    {isAdmin && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Remove"
                        onClick={async () => {
                          if (
                            await confirm({
                              title: `Remove ${c.name}?`,
                              description: "Services using it can no longer pull their repository.",
                              confirmLabel: "Remove",
                              danger: true,
                            })
                          )
                            remove.run(c.id);
                        }}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}

          <OAuthApps apps={oauthApps} isAdmin={isAdmin} />
          <OtherProviders isAdmin={isAdmin} dialogs={dialogs} />
          {!isAdmin && credentials.length === 0 && (
            <Card>
              <CardBody className="text-[13px] text-muted">Ask an organization admin to connect GitHub.</CardBody>
            </Card>
          )}
        </div>
      </PageBody>
      <MethodDialog
        provider={method}
        onClose={() => setMethod(null)}
        onOAuth={() => (setOauthSetup(method), setMethod(null))}
        onToken={() => {
          if (method) dialogs.setProvider(method);
          setMethod(null);
          dialogs.setTokenOpen(true);
        }}
      />
      <OAuthSetupDialog provider={oauthSetup} base={oauthBase} onClose={() => setOauthSetup(null)} />
      <Dialog open={connecting} onOpenChange={setConnecting}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader title="Connect another GitHub account" description="Each GitHub account or organization gets its own GitHub App." />
          <ConnectGithub publicUrl={publicUrl} baseUrl={baseUrl} embedded />
        </DialogContent>
      </Dialog>
    </>
  );
}
