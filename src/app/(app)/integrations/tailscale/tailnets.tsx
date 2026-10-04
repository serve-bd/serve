"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, MoreHorizontal, Network, Pencil, Plus, Server, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, TimeAgo } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useConfirm } from "@/components/ui/confirm";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { TailscaleSetupSteps } from "@/components/tailscale-setup";
import { useAction } from "@/hooks/use-action";
import { connectTailnet, connectThroughTailscale, removeTailnet, testTailnet, updateTailnet } from "@/server/actions/tailscale";
import { cn } from "@/lib/utils";

export type TailnetItem = {
  id: string;
  name: string;
  tailnet: string;
  authType: "oauth" | "apikey";
  clientId: string | null;
  tag: string;
  dnsSuffix: string | null;
  error: string | null;
  checkedAt: string | null;
  createdAt: string;
  servers: { id: string; name: string; address: string | null; online: boolean | null; fallback: boolean }[];
};

type Local = { id: string; name: string; tailnetId: string | null; address: string | null; dnsName: string | null; error: string | null };

function Mark() {
  return (
    <span className="flex size-10 flex-none items-center justify-center rounded-xl bg-[#242424] text-white" aria-hidden>
      <Network className="size-[18px]" />
    </span>
  );
}

export function Tailnets({ tailnets, local, root }: { tailnets: TailnetItem[]; local: Local | null; root: boolean }) {
  const [editing, setEditing] = React.useState<TailnetItem | "new" | null>(null);
  const connect = (
    <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
      <Plus /> Connect tailnet
    </Button>
  );
  return (
    <>
      <PageHeader
        title="Tailscale"
        description="Reach servers through your tailnet: servers behind NAT need no open port and no tunnel, and the private network runs over it between them."
        actions={tailnets.length > 0 && connect}
      />
      <PageBody>
        {tailnets.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Network />}
              title="No tailnet connected"
              description="Serve adds servers to the tailnet with single-use keys, finds them there and connects to their Tailscale address. Set up the tag and an OAuth client first; the dialog shows how."
              action={connect}
            />
          </Card>
        ) : (
          <div className="flex flex-col gap-4">
            {tailnets.map((t) => (
              <TailnetCard key={t.id} tailnet={t} local={local} root={root} onEdit={() => setEditing(t)} />
            ))}
          </div>
        )}
      </PageBody>
      {editing && <TailnetDialog key={editing === "new" ? "new" : editing.id} tailnet={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function TailnetCard({ tailnet: t, local, root, onEdit }: { tailnet: TailnetItem; local: Local | null; root: boolean; onEdit: () => void }) {
  const confirm = useConfirm();
  const [testing, setTesting] = React.useState(false);
  const test = useAction(testTailnet, { result: (message) => message });
  const remove = useAction(removeTailnet);
  return (
    <Card className="flex flex-col">
      <div className="flex items-start gap-3.5 p-5">
        <Mark />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold text-fg">{t.name}</h3>
          <p className="mt-0.5 truncate text-xs text-muted">
            {t.authType === "oauth" ? "OAuth client" : "API access key"} · <span className="font-mono">{t.tag}</span>
            {t.dnsSuffix && (
              <>
                {" "}
                · <span className="font-mono">{t.dnsSuffix}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-none items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            title="Call the Tailscale API now"
            loading={testing}
            onClick={async () => {
              setTesting(true);
              await test.run(t.id);
              setTesting(false);
            }}
          >
            <Zap /> <span className="hidden sm:inline">Test</span>
          </Button>
          <Menu>
            <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="More actions" />}>
              <MoreHorizontal />
            </MenuTrigger>
            <MenuContent>
              <MenuItem onClick={onEdit}>
                <Pencil /> Edit
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                danger
                onClick={async () => {
                  const back = t.servers.filter((s) => s.fallback);
                  const lost = t.servers.filter((s) => !s.fallback);
                  if (
                    await confirm({
                      title: `Disconnect ${t.name}?`,
                      description: (
                        <span className="flex flex-col gap-2">
                          <span>Serve forgets the credentials. Devices stay in the tailnet and servers keep running.</span>
                          {back.length > 0 && (
                            <span>
                              {back.map((s) => s.name).join(", ")} {back.length === 1 ? "goes" : "go"} back to {back.length === 1 ? "its" : "their"} own address or tunnel.
                            </span>
                          )}
                          {lost.length > 0 && (
                            <span className="text-bad">
                              {lost.map((s) => s.name).join(", ")} {lost.length === 1 ? "was" : "were"} added through Tailscale and become{lost.length === 1 ? "s" : ""} unreachable
                              until you connect the tailnet again.
                            </span>
                          )}
                          {local?.tailnetId === t.id && <span>This server stays in the tailnet; Serve only stops using it.</span>}
                        </span>
                      ),
                      confirmLabel: "Disconnect",
                      danger: true,
                    })
                  )
                    remove.run(t.id);
                }}
              >
                <Trash2 /> Disconnect
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </div>
      {t.error && (
        <p className="mx-5 mb-4 flex items-start gap-2 rounded-xl border border-bad/25 bg-bad-soft px-3.5 py-3 text-[12.5px] leading-relaxed break-words text-bad">
          <AlertTriangle className="mt-0.5 size-4 flex-none" />
          <span>{t.error}</span>
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line px-5 py-4 text-[13px] sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-xs text-faint">Tailnet</dt>
          <dd className="truncate font-mono text-[12px] text-fg-2">{t.tailnet === "-" ? "default (-)" : t.tailnet}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-faint">{t.authType === "oauth" ? "Client id" : "Signs in with"}</dt>
          <dd className="truncate font-mono text-[12px] text-fg-2">{t.authType === "oauth" ? t.clientId : "API access key"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-faint">Last checked</dt>
          <dd className="truncate text-fg-2">{t.checkedAt ? <TimeAgo date={t.checkedAt} /> : "Never"}</dd>
        </div>
      </dl>
      <LocalRow tailnet={t} local={local} />
      <div className="mt-auto flex min-w-0 flex-wrap items-center gap-1.5 border-t border-line px-5 py-3 text-xs text-muted">
        {t.servers.length ? (
          <>
            <span className="mr-0.5">Servers</span>
            {t.servers.map((s) => (
              <Link
                key={s.id}
                href={`/servers/${s.id}`}
                className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-1.5 py-0.5 text-fg-2 transition-colors hover:text-fg"
                title={s.address ?? "Not joined yet"}
              >
                <span className={cn("size-1.5 rounded-full", s.online ? "bg-ok" : s.address ? "bg-bad" : "bg-warn")} />
                {s.name}
              </Link>
            ))}
          </>
        ) : (
          <span>
            No servers yet.{" "}
            {root ? (
              <Link href="/servers/new" className="text-accent hover:underline">
                Add a server
              </Link>
            ) : (
              "Switch to the Root organization to add one"
            )}{" "}
            through Tailscale, or connect an existing one on its page.
          </span>
        )}
      </div>
    </Card>
  );
}

/** Whether the dashboard's own machine is in this tailnet: without it, 100.x addresses are out of reach. */
function LocalRow({ tailnet: t, local }: { tailnet: TailnetItem; local: Local | null }) {
  const confirm = useConfirm();
  const add = useAction((force: boolean) => connectThroughTailscale(local?.id ?? "", t.id, force), {
    onSuccess: async (data) => {
      if (!data.moveNeeded) return;
      if (
        await confirm({
          title: "Move this server to the tailnet?",
          description: `${data.message ?? "This machine is in another tailnet."} Moving it takes it out of that tailnet.`,
          confirmLabel: "Move it",
          danger: true,
        })
      )
        await add.run(true);
    },
  });
  if (!local) return null;
  const here = local.tailnetId === t.id && !!local.address;
  const elsewhere = !!local.tailnetId && local.tailnetId !== t.id;
  return (
    <div className="flex flex-col gap-2 border-t border-line px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 text-[13px] text-fg">
          <Server className="size-4 flex-none text-muted" />
          {here ? (
            <span className="min-w-0 truncate">
              {local.name} is in the tailnet at <span className="font-mono">{local.address}</span>
            </span>
          ) : (
            <span className="min-w-0 truncate">
              {local.name} (the dashboard&apos;s machine) {local.tailnetId === t.id && local.error ? "left this tailnet" : "is not in this tailnet"}
            </span>
          )}
        </span>
        {!here && !elsewhere && (
          <Button size="sm" loading={add.pending} onClick={() => void add.run(false)}>
            <Plus /> Add this server to the tailnet
          </Button>
        )}
      </div>
      <p className="text-xs leading-relaxed text-muted">
        {here
          ? "Serve's containers reach the tailnet through this machine."
          : elsewhere
            ? "It is in another connected tailnet. Servers in this one are reached only once the dashboard's machine can reach them too."
            : "Serve's containers reach 100.x addresses through this machine, so it must be in the tailnet before servers can be reached through it. This installs Tailscale on the host (not in a container) and joins with the tag."}
      </p>
    </div>
  );
}

function TailnetDialog({ tailnet, onClose }: { tailnet: TailnetItem | null; onClose: () => void }) {
  const [form, setForm] = React.useState({
    authType: tailnet?.authType ?? ("oauth" as "oauth" | "apikey"),
    clientId: tailnet?.clientId ?? "",
    secret: "",
    tailnet: tailnet?.tailnet ?? "-",
    tag: tailnet?.tag ?? "tag:serve",
    name: tailnet?.name ?? "",
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useAction(() => (tailnet ? updateTailnet(tailnet.id, form) : connectTailnet(form)), { onSuccess: onClose });
  const keepSecret = !!tailnet && tailnet.authType === form.authType;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <form
          method="post"
          onSubmit={(e) => {
            e.preventDefault();
            void save.run();
          }}
        >
          <DialogHeader
            title={tailnet ? `Edit ${tailnet.name}` : "Connect a tailnet"}
            description="Checked before saving: Serve lists the tailnet's devices and makes (then removes) an auth key with the tag."
          />
          <DialogBody>
            {!tailnet && (
              <div className="rounded-xl bg-surface-2 px-4 py-3.5">
                <TailscaleSetupSteps tag={form.tag || "tag:serve"} authType={form.authType} />
              </div>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Credentials">
              {(
                [
                  ["oauth", "OAuth client", "Recommended: it does not expire"],
                  ["apikey", "API access key", "Expires after at most 90 days"],
                ] as const
              ).map(([value, label, hint]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={form.authType === value}
                  onClick={() => setForm((f) => ({ ...f, authType: value }))}
                  className={cn(
                    "flex flex-col rounded-xl border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow]",
                    form.authType === value ? "border-accent bg-accent-soft/50 ring-3 ring-[var(--ring)]/25" : "border-line bg-surface hover:bg-surface-2",
                  )}
                >
                  <span className="text-[13px] font-medium text-fg">{label}</span>
                  <span className="text-[11.5px] text-muted">{hint}</span>
                </button>
              ))}
            </div>
            {form.authType === "oauth" ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Client id">
                  <Input value={form.clientId} onChange={set("clientId")} required autoComplete="off" spellCheck={false} className="font-mono text-[13px]" />
                </Field>
                <Field label="Client secret" description={keepSecret ? "Leave empty to keep the stored one." : undefined}>
                  <Input
                    type="password"
                    value={form.secret}
                    onChange={set("secret")}
                    required={!keepSecret}
                    autoComplete="new-password"
                    placeholder="tskey-client-…"
                    className="font-mono text-[13px]"
                  />
                </Field>
              </div>
            ) : (
              <Field label="API access key" description={keepSecret ? "Leave empty to keep the stored one." : undefined}>
                <Input
                  type="password"
                  value={form.secret}
                  onChange={set("secret")}
                  required={!keepSecret}
                  autoComplete="new-password"
                  placeholder="tskey-api-…"
                  className="font-mono text-[13px]"
                />
              </Field>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Tailnet" description="Its name from Settings, General, or - for the tailnet of these credentials.">
                <Input value={form.tailnet} onChange={set("tailnet")} required spellCheck={false} className="font-mono text-[13px]" />
              </Field>
              <Field label="Tag" description="Every server Serve adds gets it. Its owner must be set in the policy.">
                <Input value={form.tag} onChange={set("tag")} required spellCheck={false} className="font-mono text-[13px]" />
              </Field>
            </div>
            <Field label="Name" optional description="Shown in Serve. Defaults to the tailnet's name.">
              <Input value={form.name} onChange={set("name")} placeholder="Home lab" />
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" size="sm" loading={save.pending}>
              {tailnet ? "Save changes" : "Connect tailnet"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
