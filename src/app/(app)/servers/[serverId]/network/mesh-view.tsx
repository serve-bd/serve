"use client";

import * as React from "react";
import Link from "next/link";
import useSWR from "swr";
import { ArrowRight, Cable, EyeOff, KeyRound, LogOut, Pencil, Plus, RefreshCw, Waypoints } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge, Card, CardBody, CardFooter, CardHeader, CopyButton, EmptyState } from "@/components/ui/misc";
import { useMeshConfirm } from "@/components/mesh-confirm";
import { useAction } from "@/hooks/use-action";
import { useNow } from "@/hooks/use-client";
import { meshAddressOptions, resyncMesh, saveMesh } from "@/server/actions/mesh";
import { handshakeAge, MESH_DEFAULT_PORT, MESH_LINK_TIMEOUT, meshEndpoint, meshEndpointProblem } from "@/lib/mesh";
import type { MeshOverview, MeshPeerView } from "@/server/mesh";
import { cn, formatBytes } from "@/lib/utils";
import { Networks } from "./networks";

type Props = {
  serverId: string;
  serverName: string;
  ready: boolean;
  initial: MeshOverview;
  suggestedEndpoint: string;
  /** No public IP (it connects out): joining starts on "No public address". */
  behindNat?: boolean;
  /** Servers not in the private network (other than this one). */
  outside: number;
  services: number;
};

export function MeshView({ serverId, serverName, ready, initial, suggestedEndpoint, behindNat, outside, services }: Props) {
  const { data, mutate } = useSWR<MeshOverview>(`/api/servers/${serverId}/mesh`, {
    fallbackData: initial,
    refreshInterval: (d) => (d?.enabled && d.state !== "ready" ? 2000 : d?.state === "starting" ? 2000 : 8000),
  });
  const mesh = data ?? initial;
  const [editing, setEditing] = React.useState(false);
  // Left the network (here or elsewhere): the edit form closes, so joining again starts fresh.
  if (editing && !mesh.enabled) setEditing(false);
  const joined = mesh.enabled;

  return (
    <>
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              Private network <StateBadge mesh={mesh} />
            </span>
          }
          description="Services on different servers reach each other by their private names, over an encrypted WireGuard link between the servers."
        />
        {joined && !editing ? (
          <Joined mesh={mesh} serverId={serverId} serverName={serverName} onEdit={() => setEditing(true)} refresh={() => mutate()} />
        ) : (
          <JoinForm
            // Joining again (after leaving) starts from a fresh form, not the old edit form's state.
            key={joined ? "edit" : "join"}
            serverId={serverId}
            ready={ready}
            joined={joined}
            initialEndpoint={mesh.endpoint ?? (mesh.enabled ? "" : suggestedEndpoint)}
            initialNat={mesh.enabled ? mesh.endpoint === null : !!behindNat}
            initialPort={mesh.port ?? MESH_DEFAULT_PORT}
            networks={mesh.networks}
            onDone={() => {
              setEditing(false);
              void mutate();
            }}
            onCancel={joined ? () => setEditing(false) : undefined}
          />
        )}
      </Card>
      {joined && <Networks serverId={serverId} serverName={serverName} networks={mesh.networks} refresh={() => void mutate()} />}
      {joined && <Peers peers={mesh.peers} outside={outside} inAny={mesh.networks.some((n) => n.member)} selfNat={mesh.endpoint === null} />}
      {joined && <Addresses mesh={mesh} services={services} />}
    </>
  );
}

function StateBadge({ mesh }: { mesh: MeshOverview }) {
  if (!mesh.enabled) return mesh.state === "starting" ? <Badge tone="info">Leaving…</Badge> : <Badge>Off</Badge>;
  const problem = problemOf(mesh);
  if (problem) return <Badge tone="bad">Needs attention</Badge>;
  if (mesh.state !== "ready" || !mesh.agent) return <Badge tone="info">Starting…</Badge>;
  return <Badge tone="ok">On</Badge>;
}

function problemOf(mesh: MeshOverview): string | null {
  if (mesh.state === "error") return mesh.message ?? "The private network could not be set up on this server.";
  if (mesh.agent && !mesh.agent.ok) return mesh.agent.error;
  if (mesh.stale) return "The private network agent on this server stopped reporting. It restarts on its own; if this stays, choose Apply again.";
  return null;
}

function JoinForm({
  serverId,
  ready,
  joined,
  initialEndpoint,
  initialNat,
  initialPort,
  networks,
  onDone,
  onCancel,
}: {
  serverId: string;
  ready: boolean;
  joined: boolean;
  initialEndpoint: string;
  /** Joined without a public address: it connects out to the others. */
  initialNat: boolean;
  initialPort: number;
  networks: MeshOverview["networks"];
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [endpoint, setEndpoint] = React.useState(initialEndpoint);
  const [port, setPort] = React.useState(String(initialPort));
  const meshConfirm = useMeshConfirm();
  const [touched, setTouched] = React.useState(false);
  // Joining: the networks to go into. Kept memberships (from before leaving) come preselected;
  // with a single network it is the obvious choice; with none, a first one is created.
  const [picked, setPicked] = React.useState<string[]>(() => {
    const kept = networks.filter((n) => n.member).map((n) => n.id);
    return kept.length ? kept : networks.length === 1 ? [networks[0].id] : [];
  });
  const [newName, setNewName] = React.useState(networks.length ? "" : "Default");
  const [adding, setAdding] = React.useState(networks.length === 0);
  const newNetwork = adding && newName.trim() ? newName.trim() : undefined;
  // Networks deleted elsewhere drop out of the choice (they are no longer in the list to untick).
  const chosen = picked.filter((id) => networks.some((n) => n.id === id));
  const networkProblem = !joined && !chosen.length && !newNetwork ? "Choose a network, or create one" : null;
  const save = useAction(
    () =>
      saveMesh(serverId, {
        enabled: true,
        ...(mode === "nat" ? { nat: true } : { endpoint }),
        port: Number(port) || MESH_DEFAULT_PORT,
        ...(joined ? {} : { networks: chosen, newNetwork }),
      }),
    {
      success: joined ? "Private network updated" : "Joining the private network",
      onSuccess: onDone,
    },
  );
  // The server's own addresses, to pick from; null while they load. "custom" types one instead,
  // "nat" has none: the server connects out to servers that have one.
  const [options, setOptions] = React.useState<{ address: string; label: string }[] | null>(null);
  const [mode, setMode] = React.useState<"pick" | "custom" | "nat">(initialNat ? "nat" : "pick");
  React.useEffect(() => {
    let alive = true;
    // A failed request (network error) still leaves a form to type an address into.
    void meshAddressOptions(serverId)
      .catch(() => ({ ok: false as const, error: "" }))
      .then((r) => {
        if (!alive) return;
        const list = r.ok ? r.data : [];
        setOptions(list);
        if (initialNat) return;
        // A saved or suggested address that is not one of them stays editable.
        if (initialEndpoint && !list.some((o) => o.address === initialEndpoint)) setMode("custom");
        else if (!initialEndpoint && list[0]) setEndpoint(list[0].address);
        else if (!initialEndpoint) setMode("custom");
      });
    return () => {
      alive = false;
    };
  }, [serverId, initialEndpoint, initialNat]);
  const problem = mode === "nat" ? null : meshEndpointProblem(endpoint);
  const portNumber = Number(port);
  const portProblem = !port || portNumber < 1 || portNumber > 65535 ? "Enter a port from 1 to 65535" : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (problem || portProblem || networkProblem) return;
        // Switching a joined server to "No public address" cuts it off from servers that have none either.
        if (joined && mode === "nat" && !initialNat) {
          void meshConfirm(
            { kind: "nat", serverId },
            {
              title: "Switch to no public address?",
              description: "Other servers stop dialing this one; it connects out instead. Servers that have no public address either can no longer reach it.",
              confirmLabel: "Switch",
            },
          ).then((ok) => ok && void save.run());
          return;
        }
        void save.run();
      }}
    >
      {!joined && (
        <ul className="grid gap-x-6 gap-y-4 border-b border-line bg-surface-2/40 px-5 py-4 sm:grid-cols-3">
          <Benefit icon={<Waypoints />} title="Same names everywhere">
            <code className="font-mono text-[11px]">{"${{postgres.DATABASE_URL}}"}</code> works across servers.
          </Benefit>
          <Benefit icon={<KeyRound />} title="Encrypted">
            WireGuard, with keys only your servers hold.
          </Benefit>
          <Benefit icon={<EyeOff />} title="Nothing public">
            Only the same environment gets in.
          </Benefit>
        </ul>
      )}
      <CardBody className="flex flex-col gap-7 py-6">
        <Section title="Connection" description="The address other servers use to reach this one: its public IP, or a private IP when all servers share a LAN.">
          <Field label="Address" error={touched ? problem : null}>
            {options === null ? (
              <div className="h-[42px] animate-pulse rounded-xl bg-surface-2" />
            ) : (
              <div role="radiogroup" aria-label="Address" className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                {options.map((o) => (
                  <Choice
                    key={o.address}
                    checked={mode === "pick" && endpoint === o.address}
                    onSelect={() => {
                      setMode("pick");
                      setEndpoint(o.address);
                    }}
                  >
                    <span className="font-mono text-[13px] text-fg">{o.address}</span>
                    <span className="text-xs text-muted">{o.label}</span>
                  </Choice>
                ))}
                <Choice
                  checked={mode === "custom"}
                  onSelect={() => {
                    if (mode !== "custom") setEndpoint(options.some((o) => o.address === endpoint) ? "" : endpoint);
                    setMode("custom");
                  }}
                >
                  <span className="text-[13px] text-fg">{options.length ? "Another address" : "Address"}</span>
                  <span className="text-xs text-muted">host name or IP</span>
                </Choice>
                {mode === "custom" && (
                  <div className="bg-accent-soft/60 px-4 pt-0.5 pb-3 pl-11">
                    <Input
                      value={endpoint}
                      onChange={(e) => setEndpoint(e.target.value.trim())}
                      placeholder="203.0.113.10 or node1.example.com"
                      className="h-9 font-mono"
                      autoComplete="off"
                      autoFocus
                      aria-label="Address"
                    />
                  </div>
                )}
                <Choice checked={mode === "nat"} onSelect={() => setMode("nat")}>
                  <span className="text-[13px] text-fg">No public address</span>
                  <span className="text-xs text-muted">home internet, shared IP, behind NAT</span>
                </Choice>
                {mode === "nat" && (
                  <p className="bg-accent-soft/60 px-4 pt-0.5 pb-3 pl-11 text-xs leading-relaxed text-fg-2">
                    This server connects out to the others, so nothing needs to be opened on your router. It reaches only servers that have a public address; two servers without
                    one cannot connect to each other.
                  </p>
                )}
              </div>
            )}
          </Field>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <Field label="UDP port" error={touched ? portProblem : null} className="sm:w-32 sm:flex-none">
              <Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" className="font-mono" />
            </Field>
            <p className="flex items-start gap-2 text-xs leading-relaxed text-muted sm:pt-8">
              <Cable className="mt-px size-3.5 flex-none text-faint" />
              <span>
                {mode === "nat"
                  ? "Used by WireGuard on this server. Nothing to open on your router."
                  : "Opens on this server's firewall automatically. If your provider has a cloud firewall, allow this UDP port there too."}
              </span>
            </p>
          </div>
        </Section>
        {!joined && (
          <Section title="Networks" description="Servers reach each other only when they share a network. Pick one or more.">
            <ul className={cn("divide-y divide-line overflow-hidden rounded-xl border", touched && networkProblem ? "border-bad/50" : "border-line")}>
              {networks.map((n) => {
                const on = picked.includes(n.id);
                const others = n.servers.filter((x) => x.id !== serverId);
                return (
                  <li key={n.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-hover/50">
                      <Checkbox checked={on} onCheckedChange={(c) => setPicked((p) => (c ? [...p, n.id] : p.filter((id) => id !== n.id)))} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13px] font-medium text-fg">{n.name}</span>
                        <span className="truncate text-xs text-muted">{others.length ? others.map((x) => x.name).join(", ") : "No servers yet"}</span>
                      </span>
                      <span className="flex-none text-xs text-faint tabular-nums">
                        {others.length} server{others.length === 1 ? "" : "s"}
                      </span>
                    </label>
                  </li>
                );
              })}
              <li>
                {adding ? (
                  <div className="flex items-center gap-3 px-4 py-2.5">
                    <Plus className="size-4 flex-none text-muted" />
                    <Input
                      value={newName}
                      onChange={(e) => setNewName(e.target.value.slice(0, 40))}
                      placeholder="New network name"
                      className="h-8 flex-1"
                      autoComplete="off"
                      aria-label="New network name"
                      autoFocus={networks.length > 0}
                    />
                    {networks.length > 0 && (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          setAdding(false);
                          setNewName("");
                        }}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAdding(true)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left text-[13px] text-muted transition-colors hover:bg-hover/50 hover:text-fg"
                  >
                    <Plus className="size-4 flex-none" /> New network
                  </button>
                )}
              </li>
            </ul>
            {touched && networkProblem && <p className="text-xs text-bad">{networkProblem}</p>}
          </Section>
        )}
      </CardBody>
      <CardFooter>
        <span className="truncate text-xs text-muted">{ready ? (joined ? "Changes apply to every server in the network." : "") : "Finish setting up this server first."}</span>
        <div className="flex flex-none gap-2">
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button size="sm" variant="primary" type="submit" loading={save.pending} disabled={!ready}>
            {joined ? "Save" : "Join private network"}
          </Button>
        </div>
      </CardFooter>
    </form>
  );
}

function Benefit({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <li className="flex min-w-0 items-start gap-3">
      <span className="flex size-8 flex-none items-center justify-center rounded-lg bg-accent-soft text-accent [&_svg]:size-4">{icon}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] font-medium text-fg">{title}</span>
        <span className="text-xs leading-relaxed text-muted">{children}</span>
      </span>
    </li>
  );
}

function Choice({ checked, onSelect, children }: { checked: boolean; onSelect: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn("flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors", checked ? "bg-accent-soft/60" : "hover:bg-hover/50")}
    >
      <span className={cn("flex size-4 flex-none items-center justify-center rounded-full border", checked ? "border-accent bg-accent" : "border-line-strong bg-surface")}>
        {checked && <span className="size-1.5 rounded-full bg-accent-fg" />}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3">{children}</span>
    </button>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
        <p className="text-xs text-muted">{description}</p>
      </div>
      {children}
    </section>
  );
}

function Joined({ mesh, serverId, serverName, onEdit, refresh }: { mesh: MeshOverview; serverId: string; serverName: string; onEdit: () => void; refresh: () => void }) {
  const meshConfirm = useMeshConfirm();
  const leave = useAction(() => saveMesh(serverId, { enabled: false }), { success: `${serverName} is leaving the private network`, onSuccess: refresh });
  const apply = useAction(() => resyncMesh(serverId), { success: "Applying the configuration again", onSuccess: refresh });
  const problem = problemOf(mesh);
  return (
    <>
      <CardBody className="flex flex-col gap-4 py-5">
        {problem && <p className="rounded-xl border border-bad/25 bg-bad-soft px-3.5 py-3 text-[13px] leading-relaxed text-bad">{problem}</p>}
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
          <Fact label="Private address">
            <span className="flex items-center gap-1.5">
              <span className="font-mono">{mesh.address}</span>
              {mesh.address && <CopyButton value={mesh.address} />}
            </span>
          </Fact>
          <Fact label="Reached at">
            {mesh.endpoint ? (
              <span className="font-mono break-all">{meshEndpoint(mesh.endpoint, mesh.port ?? MESH_DEFAULT_PORT)}</span>
            ) : (
              <span className="text-fg-2">No public address · connects out</span>
            )}
          </Fact>
          <Fact label="Link">
            {mesh.agent ? (
              <span>
                WireGuard{mesh.agent.mode === "kernel" ? "" : " (userspace)"}
                <span className="text-faint"> · {mesh.agent.firewall === "iptables-legacy" ? "iptables" : "nftables"}</span>
              </span>
            ) : (
              <span className="text-muted">{mesh.state === "error" ? "Not running" : "Starting…"}</span>
            )}
          </Fact>
        </dl>
      </CardBody>
      <CardFooter className="flex-wrap">
        <span className="hidden min-w-0 flex-1 truncate text-xs text-muted sm:block">Variables that point at other servers fill in on the next deploy.</span>
        <div className="ml-auto flex flex-none gap-2">
          <Button size="sm" variant="ghost" onClick={() => void apply.run()} loading={apply.pending}>
            <RefreshCw /> Apply again
          </Button>
          <Button size="sm" onClick={onEdit}>
            <Pencil /> Edit
          </Button>
          <Button
            size="sm"
            variant="danger"
            loading={leave.pending}
            onClick={async () => {
              if (
                await meshConfirm(
                  { kind: "leave", serverId },
                  {
                    title: `Remove ${serverName} from the private network?`,
                    description: "Services on other servers can no longer reach services on this server by their private names, and the other way around.",
                    confirmLabel: "Leave network",
                  },
                )
              )
                void leave.run();
            }}
          >
            <LogOut /> Leave
          </Button>
        </div>
      </CardFooter>
    </>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-[11px] font-medium tracking-wide text-faint uppercase">{label}</dt>
      <dd className="text-[13px] text-fg">{children}</dd>
    </div>
  );
}

function linkState(p: MeshPeerView, now: number | null): "connected" | "waiting" | "error" {
  if (p.state === "error") return "error";
  if (p.latestHandshake && now && now / 1000 - p.latestHandshake < MESH_LINK_TIMEOUT) return "connected";
  return "waiting";
}

function Peers({ peers, outside, inAny, selfNat }: { peers: MeshPeerView[]; outside: number; inAny: boolean; selfNat: boolean }) {
  const now = useNow();
  return (
    <Card>
      <CardHeader title="Servers" description="Servers that share a network with this one, and the link to each of them." />
      {peers.length === 0 ? (
        <EmptyState
          icon={<Waypoints />}
          title="No other servers yet"
          description={
            !inAny
              ? "Put this server in a network first."
              : outside > 0
                ? "Open another server, join the private network and pick the same network to connect the two."
                : "Add another server, then put it in the same network."
          }
          action={
            <Link href="/servers" className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
              Servers <ArrowRight className="size-3.5" />
            </Link>
          }
        />
      ) : (
        <ul className="divide-y divide-line">
          {peers.map((p) => {
            // Neither side can be dialed: WireGuard never gets a first packet through.
            const stuck = selfNat && p.nat && linkState(p, now) !== "connected";
            const state = stuck ? "error" : linkState(p, now);
            return (
              <li key={p.serverId} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-5 py-3.5">
                <span className={cn("size-2 flex-none rounded-full", state === "connected" ? "bg-ok" : state === "error" ? "bg-bad" : "animate-led bg-warn")} aria-hidden />
                <div className="flex min-w-0 flex-1 flex-col">
                  <Link href={`/servers/${p.serverId}/network`} className="truncate text-[13px] font-medium text-fg hover:underline">
                    {p.name}
                  </Link>
                  <span className="truncate font-mono text-xs text-muted">
                    {p.address}
                    {p.endpoint && <span className="text-faint"> · {p.endpoint}</span>}
                  </span>
                </div>
                <div className="flex flex-col items-start text-xs sm:items-end">
                  <span className={cn(state === "connected" ? "text-ok" : state === "error" ? "text-bad" : "text-warn")}>
                    {state === "connected"
                      ? "Connected"
                      : stuck
                        ? "Cannot connect"
                        : state === "error"
                          ? "Not set up"
                          : p.latestHandshake
                            ? // Ages wait for the browser clock (null during hydration), so both renders match.
                              now === null
                              ? ""
                              : `No contact since ${handshakeAge(p.latestHandshake, now / 1000)}`
                            : "Waiting for contact"}
                  </span>
                  <span className="text-faint tabular-nums">
                    {state === "connected"
                      ? `${handshakeAge(p.latestHandshake, (now as number) / 1000)} · ↓ ${formatBytes(p.rx)} ↑ ${formatBytes(p.tx)}`
                      : stuck
                        ? "Neither server has a public address. Give one of them a public address."
                        : state === "error"
                          ? (p.message ?? "")
                          : "Check that UDP traffic between the servers is allowed"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function Addresses({ mesh, services }: { mesh: MeshOverview; services: number }) {
  const exposed = mesh.addresses.filter((a) => !a.idle && a.kind === "service");
  return (
    <Card>
      <CardHeader title="Services" description="Containers use the same names as on a single server. Only services of the same environment reach each other." />
      <div className="grid divide-y divide-line lg:grid-cols-2 lg:divide-x lg:divide-y-0">
        <section className="flex min-w-0 flex-col">
          <h4 className="px-5 pt-4 pb-2 text-[11px] font-medium tracking-wide text-faint uppercase">Reachable from other servers</h4>
          {exposed.length === 0 ? (
            <p className="px-5 pb-5 text-[13px] text-muted">
              {services === 0 ? "No services run on this server yet." : "None: no environment here also runs on a server that shares a network with this one."}
            </p>
          ) : (
            <ul className="pb-2">
              {exposed.map((a) => (
                <li key={a.ip} className="flex items-center gap-3 px-5 py-2">
                  <div className="flex min-w-0 flex-1 flex-col">
                    {a.href ? (
                      <Link href={a.href} className="truncate text-[13px] font-medium text-fg hover:underline">
                        {a.name}
                      </Link>
                    ) : (
                      <span className="truncate text-[13px] font-medium text-fg">{a.name}</span>
                    )}
                    <span className="truncate text-xs text-muted">{[a.projectName, a.environmentName].filter(Boolean).join(" · ")}</span>
                  </div>
                  <span className="flex-none font-mono text-xs text-fg-2">{a.ip}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="flex min-w-0 flex-col">
          <h4 className="px-5 pt-4 pb-2 text-[11px] font-medium tracking-wide text-faint uppercase">Used here, running elsewhere</h4>
          {mesh.reachable.length === 0 ? (
            <p className="px-5 pb-5 text-[13px] text-muted">None: services here only use services on this server.</p>
          ) : (
            <ul className="pb-2">
              {mesh.reachable.map((r) => (
                <li key={r.ip} className="flex items-center gap-3 px-5 py-2">
                  <div className="flex min-w-0 flex-1 flex-col">
                    {r.href ? (
                      <Link href={r.href} className="truncate text-[13px] font-medium text-fg hover:underline">
                        {r.serviceName}
                      </Link>
                    ) : (
                      <span className="truncate text-[13px] font-medium text-fg">{r.serviceName}</span>
                    )}
                    <span className="truncate font-mono text-xs text-muted">{r.names.join(", ")}</span>
                  </div>
                  <Badge className="flex-none">on {r.serverName}</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Card>
  );
}
