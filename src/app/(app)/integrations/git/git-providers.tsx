"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowUpRight, Check, ChevronRight, FolderGit2, KeyRound, Plus, Settings2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardBody, CardHeader, CopyField, TimeAgo } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { useAction } from "@/hooks/use-action";
import { addGitToken, createDeployKey, deleteGitCredential, githubAppInstallUrl, startGithubApp } from "@/server/actions/integrations";
import type { GitProviderType } from "@/server/db/schema";
import { cn } from "@/lib/utils";
import { postManifest } from "@/lib/github";
import { GithubMark } from "@/components/github-mark";

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
  github: "Fine-grained token with Contents: Read and Metadata: Read. Webhooks must then be added per repository.",
  gitlab: "Preferences → Access tokens with the read_repository and read_api scopes.",
  gitea: "Settings → Applications → Generate token with repository read access.",
  bitbucket: "An access token or app password with repository read access.",
};

function ConnectGithub({ publicUrl, baseUrl }: { publicUrl: boolean; baseUrl: string }) {
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

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-5 p-6 sm:flex-row sm:items-start">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-fg text-bg shadow-sm">
          <GithubMark className="size-6" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h3 className="text-[17px] font-semibold text-fg">Connect GitHub</h3>
            <p className="text-[13px] leading-relaxed text-muted">
              Serve creates a private GitHub App for this server. You choose which repositories it can read. Deploys on push and pull request previews then work without any
              webhook setup.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-sunken p-1 sm:max-w-sm">
            {(["personal", "organization"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setOwnerType(t)}
                className={cn("h-8 rounded-lg text-[13px] font-medium transition-all", ownerType === t ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg")}
              >
                {t === "personal" ? "Personal account" : "GitHub organization"}
              </button>
            ))}
          </div>
          {ownerType === "organization" && (
            <Field label="Organization name" description="You need to be an owner of the GitHub organization.">
              <Input value={organization} onChange={(e) => setOrganization(e.target.value)} placeholder="acme" className="sm:max-w-sm" autoFocus />
            </Field>
          )}
          {!publicUrl && (
            <p className="flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2.5 text-xs leading-relaxed text-warn">
              <AlertTriangle className="mt-px size-3.5 shrink-0" />
              <span>
                Serve is reached at <span className="font-mono">{baseUrl}</span>, which GitHub cannot reach. Repositories and deploys work, but push events need a public dashboard
                domain (Server settings).
              </span>
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={connect} loading={pending} disabled={ownerType === "organization" && !organization.trim()}>
              <GithubMark className="size-4" /> Continue on GitHub
            </Button>
            <span className="text-xs text-faint">Takes about 30 seconds.</span>
          </div>
        </div>
      </div>
      <div className="grid gap-px border-t border-line bg-line sm:grid-cols-3">
        {[
          ["Create the app", "Review the name and click Create on GitHub."],
          ["Pick repositories", "Allow all or only the ones you want to deploy."],
          ["Deploy", "Choose a repository when creating a service."],
        ].map(([title, body], i) => (
          <div key={title} className="flex gap-3 bg-surface-2 px-5 py-3.5">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface text-[11px] font-semibold text-muted ring-1 ring-line">{i + 1}</span>
            <span className="flex flex-col">
              <span className="text-[13px] font-medium text-fg-2">{title}</span>
              <span className="text-xs text-muted">{body}</span>
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function OtherProviders({ isAdmin }: { isAdmin: boolean }) {
  const [tokenOpen, setTokenOpen] = React.useState(false);
  const [keyOpen, setKeyOpen] = React.useState(false);
  const [provider, setProvider] = React.useState<GitProviderType>("gitlab");
  const [name, setName] = React.useState("");
  const [token, setToken] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [keyName, setKeyName] = React.useState("");
  const [publicKey, setPublicKey] = React.useState<string | null>(null);
  const add = useAction(() => addGitToken({ provider, name, token, baseUrl }), {
    success: (d) => `Connected as ${d.login}`,
    onSuccess: () => {
      setTokenOpen(false);
      setToken("");
      setName("");
    },
  });
  const key = useAction(() => createDeployKey(keyName), { onSuccess: (d) => setPublicKey(d.publicKey) });

  if (!isAdmin) return null;
  return (
    <>
      <Card>
        <CardHeader title="Other providers" description="GitLab, Gitea and Bitbucket use access tokens. SSH deploy keys work with any Git host." />
        <div className="divide-y divide-line">
          <button type="button" onClick={() => setTokenOpen(true)} className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-hover/50">
            <FolderGit2 className="size-4 text-muted" />
            <span className="flex flex-1 flex-col">
              <span className="text-[13px] font-medium text-fg">Add an access token</span>
              <span className="text-xs text-muted">GitLab, Gitea, Bitbucket, or a GitHub personal token</span>
            </span>
            <ChevronRight className="size-4 text-faint" />
          </button>
          <button type="button" onClick={() => { setPublicKey(null); setKeyName(""); setKeyOpen(true); }} className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-hover/50">
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
          <form onSubmit={(e) => { e.preventDefault(); void add.run(); }}>
            <DialogHeader title="Add access token" description="Serve verifies the token and lists the repositories it can read." />
            <DialogBody>
              <Field label="Provider">
                <Select value={provider} onValueChange={(v) => setProvider(v as GitProviderType)} options={["gitlab", "gitea", "bitbucket", "github"].map((p) => ({ value: p, label: providerNames[p] }))} />
              </Field>
              {provider !== "bitbucket" && (
                <Field label="Server URL" optional description={provider === "github" ? "Only for GitHub Enterprise Server." : "Leave empty for the hosted service."}>
                  <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={provider === "gitea" ? "https://git.example.com" : "https://gitlab.example.com"} />
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
              <Button type="submit" variant="primary" size="sm" loading={add.pending}>Connect</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={keyOpen} onOpenChange={setKeyOpen}>
        <DialogContent>
          <form onSubmit={(e) => { e.preventDefault(); if (!publicKey) void key.run(); else setKeyOpen(false); }}>
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
              <Button type="submit" variant="primary" size="sm" loading={key.pending}>{publicKey ? "Done" : "Generate key"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function GitProviders({ credentials, isAdmin, baseUrl, publicUrl }: { credentials: Cred[]; isAdmin: boolean; baseUrl: string; publicUrl: boolean }) {
  const confirm = useConfirm();
  const router = useRouter();
  const params = useSearchParams();
  const remove = useAction(deleteGitCredential, { success: "Removed" });
  const configure = useAction(githubAppInstallUrl, { refresh: false, onSuccess: (url) => { window.location.href = url; } });

  const announced = React.useRef(false);
  React.useEffect(() => {
    const connected = params.get("connected");
    const error = params.get("error");
    if ((!connected && !error) || announced.current) return;
    announced.current = true;
    if (connected) toast.success(`GitHub connected`, `Serve can now deploy repositories from ${connected}.`);
    if (error) toast.error("GitHub setup did not finish", error);
    router.replace("/integrations/git");
  }, [params, router]);

  const apps = credentials.filter((c) => c.provider === "github-app");
  const others = credentials.filter((c) => c.provider !== "github-app");

  return (
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
                    {c.app?.installed ? <Badge tone="ok"><Check /> Installed</Badge> : <Badge tone="warn">Not installed</Badge>}
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
                    <a href={c.app?.settingsUrl} target="_blank" rel="noreferrer" className="rounded-lg p-2 text-muted hover:bg-hover hover:text-fg" aria-label="App settings on GitHub">
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

      {isAdmin && (apps.length === 0 ? <ConnectGithub publicUrl={publicUrl} baseUrl={baseUrl} /> : (
        <details className="group rounded-2xl border border-line bg-surface shadow-sm">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 text-[13px] font-medium text-fg-2">
            <Plus className="size-4 text-muted" /> Connect another GitHub account or organization
            <ChevronRight className="ml-auto size-4 text-faint transition-transform group-open:rotate-90" />
          </summary>
          <div className="border-t border-line p-2"><ConnectGithub publicUrl={publicUrl} baseUrl={baseUrl} /></div>
        </details>
      ))}

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
                  <Button size="icon-sm" variant="ghost" aria-label="Remove" onClick={async () => { if (await confirm({ title: `Remove ${c.name}?`, description: "Services using it can no longer pull their repository.", confirmLabel: "Remove", danger: true })) remove.run(c.id); }}>
                    <Trash2 />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      <OtherProviders isAdmin={isAdmin} />
      {!isAdmin && credentials.length === 0 && (
        <Card><CardBody className="text-[13px] text-muted">Ask an organization admin to connect GitHub.</CardBody></Card>
      )}
    </div>
  );
}
