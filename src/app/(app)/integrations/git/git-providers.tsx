"use client";

import * as React from "react";
import { FolderGit2, KeyRound, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CopyField, EmptyState, TimeAgo } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { addGitToken, createDeployKey, deleteGitCredential } from "@/server/actions/integrations";
import type { GitProviderType } from "@/server/db/schema";

type Cred = { id: string; name: string; provider: string; publicInfo: string | null; baseUrl: string | null; createdAt: string };

const providerNames: Record<string, string> = { github: "GitHub", gitlab: "GitLab", gitea: "Gitea", bitbucket: "Bitbucket", ssh: "SSH deploy key" };

const tokenHelp: Record<string, string> = {
  github: "Settings → Developer settings → Fine-grained tokens. Grant Contents: Read and Metadata: Read.",
  gitlab: "Preferences → Access tokens with the read_repository and read_api scopes.",
  gitea: "Settings → Applications → Generate token with repository read access.",
  bitbucket: "Personal settings → App passwords or an access token with repository read.",
};

export function GitProviders({ credentials, isAdmin }: { credentials: Cred[]; isAdmin: boolean }) {
  const confirm = useConfirm();
  const [tokenOpen, setTokenOpen] = React.useState(false);
  const [keyOpen, setKeyOpen] = React.useState(false);
  const [provider, setProvider] = React.useState<GitProviderType>("github");
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
  const remove = useAction(deleteGitCredential, { success: "Removed" });

  return (
    <div className="flex flex-col gap-4">
      {isAdmin && (
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={() => { setPublicKey(null); setKeyName(""); setKeyOpen(true); }}>
            <KeyRound /> Create deploy key
          </Button>
          <Button size="sm" variant="primary" onClick={() => setTokenOpen(true)}>
            <Plus /> Add access token
          </Button>
        </div>
      )}
      <Card className="overflow-hidden">
        {credentials.length === 0 ? (
          <EmptyState icon={<FolderGit2 />} title="No git providers connected" description="Public repositories work without credentials. Add a token to browse and deploy private repositories." />
        ) : (
          <div className="divide-y divide-line">
            {credentials.map((c) => (
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
                <Badge>{providerNames[c.provider]}</Badge>
                {isAdmin && (
                  <Menu>
                    <MenuTrigger className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label="Actions">
                      <Trash2 className="size-4" />
                    </MenuTrigger>
                    <MenuContent>
                      <MenuItem danger onClick={async () => { if (await confirm({ title: `Remove ${c.name}?`, description: "Services using it can no longer pull their repository.", confirmLabel: "Remove", danger: true })) remove.run(c.id); }}>
                        <Trash2 /> Remove
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Dialog open={tokenOpen} onOpenChange={setTokenOpen}>
        <DialogContent>
          <form onSubmit={(e) => { e.preventDefault(); void add.run(); }}>
            <DialogHeader title="Add access token" description="Serve verifies the token and lists repositories you can deploy." />
            <DialogBody>
              <Field label="Provider">
                <Select value={provider} onValueChange={(v) => setProvider(v as GitProviderType)} options={["github", "gitlab", "gitea", "bitbucket"].map((p) => ({ value: p, label: providerNames[p] }))} />
              </Field>
              {(provider === "gitea" || provider === "gitlab" || provider === "github") && (
                <Field label="Server URL" optional description={provider === "github" ? "Only for GitHub Enterprise." : "Leave empty for the hosted service."}>
                  <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={provider === "gitea" ? "https://git.example.com" : "https://gitlab.example.com"} />
                </Field>
              )}
              <Field label="Token" description={tokenHelp[provider]}>
                <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} required className="font-mono" autoComplete="off" />
              </Field>
              <Field label="Name" optional>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Company GitHub" />
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
            <DialogHeader title="Create deploy key" description="An SSH key pair is generated on the server. Add the public key to your repository with read access." />
            <DialogBody>
              {publicKey ? (
                <Field label="Public key" description="Add this under the repository's Deploy keys. Then use the SSH clone URL (git@…) for your service.">
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
    </div>
  );
}
