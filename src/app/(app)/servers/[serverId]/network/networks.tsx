"use client";

import * as React from "react";
import Link from "next/link";
import { MoreHorizontal, Network, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge, Card, CardHeader } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { createNetwork, deleteNetwork, renameNetwork, setNetworkMember } from "@/server/actions/mesh";
import type { MeshNetworkView } from "@/server/mesh";
import { cn } from "@/lib/utils";

/** Name a new private network, or rename one. */
export function NetworkNameDialog({
  open,
  onOpenChange,
  title,
  description,
  initial = "",
  confirmLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  initial?: string;
  confirmLabel: string;
  onSubmit: (name: string) => Promise<unknown>;
}) {
  const [name, setName] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) setName(initial);
  }, [open, initial]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim() || busy) return;
            setBusy(true);
            try {
              if ((await onSubmit(name.trim())) !== undefined) onOpenChange(false);
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogHeader title={title} description={description} />
          <DialogBody>
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value.slice(0, 40))} placeholder="Production" autoFocus autoComplete="off" />
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!name.trim()}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The private networks, with a switch for this server's place in each. */
export function Networks({ serverId, serverName, networks, refresh }: { serverId: string; serverName: string; networks: MeshNetworkView[]; refresh: () => void }) {
  const confirm = useConfirm();
  const [creating, setCreating] = React.useState(false);
  const [renaming, setRenaming] = React.useState<MeshNetworkView | null>(null);
  const [toggling, setToggling] = React.useState<string | null>(null);
  const toggle = useAction((networkId: string, member: boolean) => setNetworkMember(networkId, serverId, member), { onSuccess: refresh });
  const create = useAction((name: string) => createNetwork(name, [serverId]), { success: "Private network created", onSuccess: refresh });
  const rename = useAction((id: string, name: string) => renameNetwork(id, name), { success: "Private network renamed", onSuccess: refresh });
  const remove = useAction(deleteNetwork, { success: "Private network deleted", onSuccess: refresh });
  const inAny = networks.some((n) => n.member);

  return (
    <Card>
      <CardHeader
        title="Networks"
        description="Servers reach each other only when they share a network. A server can be in several."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> New network
          </Button>
        }
      />
      {!inAny && (
        <p className="mx-5 mb-4 rounded-xl border border-warn/25 bg-warn-soft px-3.5 py-3 text-[13px] leading-relaxed text-fg-2">
          {serverName} is in no network, so no other server reaches it. Turn on a network below.
        </p>
      )}
      {networks.length > 0 && (
        <ul className="divide-y divide-line border-t border-line">
          {networks.map((n) => {
            const others = n.servers.filter((s) => s.id !== serverId);
            return (
              <li key={n.id} className="flex items-center gap-3 px-5 py-3.5">
                <Network className={cn("size-4 flex-none", n.member ? "text-accent" : "text-faint")} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[13px] font-medium text-fg">{n.name}</span>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted">
                    {others.length === 0 ? (
                      <span>{n.member ? "No other server yet" : "No servers yet"}</span>
                    ) : (
                      others.map((s, i) => (
                        <span key={s.id} className="inline-flex items-center gap-1">
                          <Link href={`/servers/${s.id}/network`} className="hover:text-fg hover:underline">
                            {s.name}
                          </Link>
                          {!s.joined && <Badge className="px-1.5 py-0 text-[10px]">off</Badge>}
                          {i < others.length - 1 && <span className="text-faint">·</span>}
                        </span>
                      ))
                    )}
                  </span>
                </div>
                <Switch
                  aria-label={`${serverName} in ${n.name}`}
                  checked={n.member}
                  disabled={toggling === n.id}
                  onCheckedChange={async (on) => {
                    if (
                      !on &&
                      others.length > 0 &&
                      !(await confirm({
                        title: `Take ${serverName} out of ${n.name}?`,
                        description: `Services here and on ${others.map((s) => s.name).join(", ")} stop reaching each other by their private names, unless they share another network.`,
                        confirmLabel: "Take out",
                        danger: true,
                      }))
                    )
                      return;
                    setToggling(n.id);
                    try {
                      await toggle.run(n.id, on);
                    } finally {
                      setToggling(null);
                    }
                  }}
                />
                <Menu>
                  <MenuTrigger render={<Button variant="ghost" size="xs" aria-label={`More for ${n.name}`} />}>
                    <MoreHorizontal />
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem onClick={() => setRenaming(n)}>
                      <Pencil /> Rename
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      danger
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Delete ${n.name}?`,
                            description: n.servers.length
                              ? `${n.servers.map((s) => s.name).join(", ")} stop reaching each other through it. Servers that share another network keep that link.`
                              : "No server is in it.",
                            confirmLabel: "Delete network",
                            danger: true,
                          })
                        )
                          void remove.run(n.id);
                      }}
                    >
                      <Trash2 /> Delete
                    </MenuItem>
                  </MenuContent>
                </Menu>
              </li>
            );
          })}
        </ul>
      )}
      <NetworkNameDialog
        open={creating}
        onOpenChange={setCreating}
        title="New private network"
        description={`${serverName} goes into it. Add other servers from their Private network page.`}
        confirmLabel="Create network"
        onSubmit={(name) => create.run(name)}
      />
      <NetworkNameDialog
        open={!!renaming}
        onOpenChange={(o) => !o && setRenaming(null)}
        title="Rename private network"
        initial={renaming?.name ?? ""}
        confirmLabel="Rename"
        onSubmit={(name) => (renaming ? rename.run(renaming.id, name) : Promise.resolve(undefined))}
      />
    </Card>
  );
}
