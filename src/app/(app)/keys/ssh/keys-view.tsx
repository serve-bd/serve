"use client";

import * as React from "react";
import { useRouter } from "@/hooks/use-router";
import { KeyRound, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardHeader, EmptyState, TimeAgo } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { useConfirm } from "@/components/ui/confirm";
import { SshPublicKey } from "@/components/ssh-public-key";
import { useAction } from "@/hooks/use-action";
import { createPrivateKey, deletePrivateKey } from "@/server/actions/servers";
import { cn } from "@/lib/utils";

type Key = { id: string; name: string; description: string | null; publicKey: string; fingerprint: string; createdAt: string; servers: string[] };

/** Generate or import a key. Shows the public key once created. */
export function AddKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (key: { id: string; name: string; publicKey: string }) => void;
}) {
  const [mode, setMode] = React.useState<"generate" | "import">("generate");
  const [name, setName] = React.useState("");
  const [pem, setPem] = React.useState("");
  const [created, setCreated] = React.useState<{ id: string; publicKey: string } | null>(null);
  const create = useAction(() => createPrivateKey({ name, privateKey: mode === "import" ? pem : undefined }), {
    success: mode === "import" ? "Key imported" : "Key generated",
    onSuccess: (k) => {
      setCreated(k);
      onCreated?.({ id: k.id, name, publicKey: k.publicKey });
    },
  });
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setCreated(null);
      setName("");
      setPem("");
      setMode("generate");
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent size="lg">
        {created ? (
          <>
            <DialogHeader title={`${name} is ready`} description="Authorize the public key on every server that should use it." />
            <DialogBody>
              <SshPublicKey publicKey={created.publicKey} />
            </DialogBody>
            <DialogFooter>
              <Button variant="primary" onClick={() => close(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void create.run();
            }}
          >
            <DialogHeader title="Add SSH key" description={<>The key connects to your servers. The private key is encrypted at rest.</>} />
            <DialogBody>
              <div className="grid grid-cols-2 gap-1 rounded-xl bg-sunken p-1" role="radiogroup" aria-label="Key source">
                {(
                  [
                    ["generate", "Generate new key"],
                    ["import", "Use existing key"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={mode === value}
                    onClick={() => setMode(value)}
                    className={cn(
                      "h-8 rounded-lg text-[13px] font-medium transition-colors",
                      mode === value ? "bg-surface text-fg shadow-sm ring-1 ring-line" : "text-muted hover:text-fg",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Production servers" autoFocus />
              </Field>
              {mode === "import" ? (
                <Field label="Private key" description="OpenSSH or PEM format, without a passphrase.">
                  <Textarea
                    value={pem}
                    onChange={(e) => setPem(e.target.value)}
                    rows={7}
                    placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----"}
                    className="font-mono text-[12px]"
                    spellCheck={false}
                  />
                </Field>
              ) : (
                <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] leading-relaxed text-muted">
                  An ed25519 key pair is created. You copy the public key to your servers; the private key never leaves the dashboard.
                </p>
              )}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={create.pending} disabled={!name.trim() || (mode === "import" && !pem.trim())}>
                {mode === "import" ? "Import key" : "Generate key"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function KeysView({ keys }: { keys: Key[] }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [open, setOpen] = React.useState(false);
  const [viewing, setViewing] = React.useState<Key | null>(null);
  const remove = useAction(deletePrivateKey, { success: "Key deleted" });

  return (
    <>
      <Card>
        <CardHeader
          title="SSH keys"
          description={<>Keys used to reach remote servers.</>}
          actions={
            <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
              <Plus /> Add key
            </Button>
          }
        />
        {keys.length === 0 ? (
          <EmptyState icon={<KeyRound />} title="No SSH keys yet" description="Add a key before adding a remote server, or create one in the Add server flow." />
        ) : (
          <div className="divide-y divide-line">
            {keys.map((k) => (
              <div key={k.id} className="flex items-center gap-3.5 px-5 py-3.5">
                <span className="flex size-9 flex-none items-center justify-center rounded-[10px] border border-line bg-surface-2 text-fg-2">
                  <KeyRound className="size-4" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate text-[14px] font-medium text-fg">{k.name}</span>
                    {k.servers.length > 0 ? (
                      <Tooltip content={k.servers.join(", ")}>
                        <span>
                          <Badge tone="accent">
                            {k.servers.length} server{k.servers.length === 1 ? "" : "s"}
                          </Badge>
                        </span>
                      </Tooltip>
                    ) : (
                      <Badge>Unused</Badge>
                    )}
                  </div>
                  <span className="truncate font-mono text-[11.5px] text-muted">{k.fingerprint}</span>
                  <span className="text-xs text-faint">
                    Added <TimeAgo date={k.createdAt} />
                  </span>
                </div>
                <Menu>
                  <MenuTrigger className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label="Key actions">
                    <MoreHorizontal className="size-4" />
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem onClick={() => setViewing(k)}>
                      <KeyRound /> Show public key
                    </MenuItem>
                    <MenuItem
                      danger
                      disabled={k.servers.length > 0}
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Delete ${k.name}?`,
                            description: "This key can no longer be used. Servers that trust it keep the public key until you remove it there.",
                            confirmLabel: "Delete key",
                            danger: true,
                          })
                        )
                          remove.run(k.id);
                      }}
                    >
                      <Trash2 /> {k.servers.length > 0 ? "In use, cannot delete" : "Delete"}
                    </MenuItem>
                  </MenuContent>
                </Menu>
              </div>
            ))}
          </div>
        )}
      </Card>

      <AddKeyDialog open={open} onOpenChange={setOpen} onCreated={() => router.refresh()} />

      <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent size="lg">
          <DialogHeader title={viewing?.name ?? ""} description={viewing?.fingerprint} />
          <DialogBody>{viewing && <SshPublicKey publicKey={viewing.publicKey} />}</DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
