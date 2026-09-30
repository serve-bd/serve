"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, MoreHorizontal, Network, Pencil, Plus, Server as ServerIcon, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardHeader, EmptyState } from "@/components/ui/misc";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { createNetwork, deleteNetwork, renameNetwork, setNetworkMember } from "@/server/actions/mesh";
import type { MeshNetworkView } from "@/server/mesh";
import { NetworkNameDialog } from "../servers/[serverId]/network/networks";
import { cn } from "@/lib/utils";

type ServerRow = { id: string; name: string; joined: boolean; state: "starting" | "ready" | "error" | "off" | null; message: string | null; address: string | null };

const stateOf = (s: ServerRow) =>
  !s.joined
    ? { dot: "bg-faint", label: "Not joined", tone: "text-muted" }
    : s.state === "error"
      ? { dot: "bg-bad", label: "Needs attention", tone: "text-bad" }
      : s.state === "ready"
        ? { dot: "bg-ok", label: "Ready", tone: "text-muted" }
        : { dot: "animate-led bg-warn", label: "Starting…", tone: "text-warn" };

/** Every private network with its servers; add and remove servers, create, rename and delete networks. */
export function PrivateNetworks({ networks, servers }: { networks: Omit<MeshNetworkView, "member">[]; servers: ServerRow[] }) {
  const confirm = useConfirm();
  const [creating, setCreating] = React.useState(false);
  const [renaming, setRenaming] = React.useState<{ id: string; name: string } | null>(null);
  const create = useAction((name: string) => createNetwork(name), { success: "Private network created" });
  const rename = useAction((id: string, name: string) => renameNetwork(id, name), { success: "Private network renamed" });
  const remove = useAction(deleteNetwork, { success: "Private network deleted" });
  const member = useAction((networkId: string, serverId: string, on: boolean) => setNetworkMember(networkId, serverId, on), {
    success: "Saved. Servers pick up the change within seconds.",
  });
  const byId = new Map(servers.map((s) => [s.id, s]));
  const inSome = new Set(networks.flatMap((n) => n.servers.map((s) => s.id)));
  const notJoined = servers.filter((s) => !s.joined);
  const alone = servers.filter((s) => s.joined && !inSome.has(s.id));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-muted">
          {networks.length} network{networks.length === 1 ? "" : "s"} · {servers.filter((s) => s.joined).length} of {servers.length} server{servers.length === 1 ? "" : "s"} joined
        </p>
        <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
          <Plus /> New network
        </Button>
      </div>

      {networks.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Network />}
            title="No private networks yet"
            description="Create a network, then add servers to it. Servers join the private network from their own page first."
            action={
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus /> New network
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {networks.map((n) => {
            const candidates = servers.filter((s) => !n.servers.some((m) => m.id === s.id));
            return (
              <Card key={n.id} className="flex flex-col">
                <CardHeader
                  title={
                    <span className="flex min-w-0 items-center gap-2">
                      <Network className="size-4 flex-none text-accent" />
                      <span className="truncate">{n.name}</span>
                    </span>
                  }
                  description={`${n.servers.length} server${n.servers.length === 1 ? "" : "s"}`}
                  actions={
                    <div className="flex items-center gap-1">
                      <Menu>
                        <MenuTrigger render={<Button size="xs" disabled={!candidates.length} />}>
                          <Plus /> Add server
                        </MenuTrigger>
                        <MenuContent className="w-64">
                          <MenuLabel>Add to {n.name}</MenuLabel>
                          {candidates.map((s) => (
                            <MenuItem key={s.id} disabled={!s.joined} onClick={() => void member.run(n.id, s.id, true)}>
                              <ServerIcon />
                              <span className="min-w-0 flex-1 truncate">{s.name}</span>
                              {!s.joined && <span className="text-xs text-faint">not joined</span>}
                            </MenuItem>
                          ))}
                          {candidates.some((s) => !s.joined) && <p className="px-2 pt-1 pb-1.5 text-xs text-faint">Servers join from their Private network page.</p>}
                        </MenuContent>
                      </Menu>
                      <Menu>
                        <MenuTrigger render={<Button variant="ghost" size="xs" aria-label={`More for ${n.name}`} />}>
                          <MoreHorizontal />
                        </MenuTrigger>
                        <MenuContent>
                          <MenuItem onClick={() => setRenaming({ id: n.id, name: n.name })}>
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
                    </div>
                  }
                />
                {n.servers.length === 0 ? (
                  <p className="px-5 py-6 text-center text-[13px] text-muted">No servers yet. Add one to start.</p>
                ) : (
                  <ul className="divide-y divide-line">
                    {n.servers.map((m) => {
                      const s = byId.get(m.id) ?? { ...m, state: null, message: null, address: null };
                      const st = stateOf(s);
                      return (
                        <li key={m.id} className="flex items-center gap-3 px-5 py-3">
                          <span className={cn("size-2 flex-none rounded-full", st.dot)} aria-hidden />
                          <div className="flex min-w-0 flex-1 flex-col">
                            <Link href={`/servers/${m.id}/network`} className="truncate text-[13px] font-medium text-fg hover:underline">
                              {m.name}
                            </Link>
                            <span className={cn("truncate text-xs", st.tone)} title={s.message ?? undefined}>
                              {s.address ? <span className="font-mono text-muted">{s.address} · </span> : null}
                              {st.label}
                            </span>
                          </div>
                          <Tooltip content={`Remove from ${n.name}`}>
                            <Button
                              variant="ghost"
                              size="xs"
                              aria-label={`Remove ${m.name} from ${n.name}`}
                              onClick={async () => {
                                const others = n.servers.filter((x) => x.id !== m.id);
                                if (
                                  others.length &&
                                  !(await confirm({
                                    title: `Remove ${m.name} from ${n.name}?`,
                                    description: `Services on ${m.name} and on ${others.map((x) => x.name).join(", ")} stop reaching each other by their private names, unless they share another network.`,
                                    confirmLabel: "Remove",
                                    danger: true,
                                  }))
                                )
                                  return;
                                void member.run(n.id, m.id, false);
                              }}
                            >
                              <X />
                            </Button>
                          </Tooltip>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {alone.length > 0 && (
        <Card>
          <CardHeader title="Joined, but in no network" description="These servers run the private network but reach no other server. Add them to a network above." />
          <ul className="divide-y divide-line">
            {alone.map((s) => (
              <ServerLine key={s.id} server={s} />
            ))}
          </ul>
        </Card>
      )}

      {notJoined.length > 0 && (
        <Card>
          <CardHeader title="Not joined" description="Join a server from its Private network page: pick the address other servers use and its networks." />
          <ul className="divide-y divide-line">
            {notJoined.map((s) => (
              <ServerLine key={s.id} server={s} action />
            ))}
          </ul>
        </Card>
      )}

      <NetworkNameDialog
        open={creating}
        onOpenChange={setCreating}
        title="New private network"
        description="Add servers to it next."
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
    </div>
  );
}

function ServerLine({ server, action }: { server: ServerRow; action?: boolean }) {
  const st = stateOf(server);
  return (
    <li className="flex items-center gap-3 px-5 py-3">
      <span className={cn("size-2 flex-none rounded-full", st.dot)} aria-hidden />
      <Link href={`/servers/${server.id}/network`} className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg hover:underline">
        {server.name}
      </Link>
      {action ? (
        <Link href={`/servers/${server.id}/network`} className="inline-flex flex-none items-center gap-1 text-[13px] font-medium text-accent hover:underline">
          Join <ArrowRight className="size-3.5" />
        </Link>
      ) : (
        <Badge tone="warn">No network</Badge>
      )}
    </li>
  );
}
