"use client";

import * as React from "react";
import Link from "next/link";
import useSWR from "swr";
import { ArrowRight, Cable, EyeOff, KeyRound, LogOut, Pencil, RefreshCw, Waypoints } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Badge, Card, CardBody, CardFooter, CardHeader, CopyButton, EmptyState } from "@/components/ui/misc";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { useNow } from "@/hooks/use-client";
import { meshAddressOptions, resyncMesh, saveMesh } from "@/server/actions/mesh";
import { handshakeAge, MESH_DEFAULT_PORT, MESH_LINK_TIMEOUT, meshEndpointProblem } from "@/lib/mesh";
import type { MeshOverview, MeshPeerView } from "@/server/mesh";
import { cn, formatBytes } from "@/lib/utils";

type Props = {
  serverId: string;
  serverName: string;
  ready: boolean;
  initial: MeshOverview;
  suggestedEndpoint: string;
  /** Servers not in the private network (other than this one). */
  outside: number;
  services: number;
};

export function MeshView({ serverId, serverName, ready, initial, suggestedEndpoint, outside, services }: Props) {
  const { data, mutate } = useSWR<MeshOverview>(`/api/servers/${serverId}/mesh`, {
    fallbackData: initial,
    refreshInterval: (d) => (d?.enabled && d.state !== "ready" ? 2000 : d?.state === "starting" ? 2000 : 8000),
  });
  const mesh = data ?? initial;
  const [editing, setEditing] = React.useState(false);
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
            serverId={serverId}
            ready={ready}
            joined={joined}
            initialEndpoint={mesh.endpoint ?? suggestedEndpoint}
            initialPort={mesh.port ?? MESH_DEFAULT_PORT}
            onDone={() => {
              setEditing(false);
              void mutate();
            }}
            onCancel={joined ? () => setEditing(false) : undefined}
          />
        )}
      </Card>
      {joined && <Peers peers={mesh.peers} outside={outside} />}
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
  initialPort,
  onDone,
  onCancel,
}: {
  serverId: string;
  ready: boolean;
  joined: boolean;
  initialEndpoint: string;
  initialPort: number;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [endpoint, setEndpoint] = React.useState(initialEndpoint);
  const [port, setPort] = React.useState(String(initialPort));
  const [touched, setTouched] = React.useState(false);
  const save = useAction(() => saveMesh(serverId, { enabled: true, endpoint, port: Number(port) || MESH_DEFAULT_PORT }), {
    success: joined ? "Private network updated" : "Joining the private network",
    onSuccess: onDone,
  });
  const [options, setOptions] = React.useState<{ address: string; label: string }[]>([]);
  React.useEffect(() => {
    let alive = true;
    void meshAddressOptions(serverId).then((r) => {
      if (alive && r.ok) setOptions(r.data);
    });
    return () => {
      alive = false;
    };
  }, [serverId]);
  const problem = meshEndpointProblem(endpoint);
  const portNumber = Number(port);
  const portProblem = !port || portNumber < 1 || portNumber > 65535 ? "Enter a port from 1 to 65535" : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!problem && !portProblem) void save.run();
      }}
    >
      <CardBody className="flex flex-col gap-5 py-5">
        {!joined && (
          <ul className="grid gap-3 sm:grid-cols-3">
            <Benefit icon={<Waypoints />} title="Same names everywhere">
              <code className="font-mono">{"${{postgres.DATABASE_URL}}"}</code> works when the database runs on another server.
            </Benefit>
            <Benefit icon={<KeyRound />} title="Encrypted">
              Traffic between servers goes through WireGuard, with keys only these servers hold.
            </Benefit>
            <Benefit icon={<EyeOff />} title="Nothing public">
              Databases stay private. Only services of the same environment reach each other.
            </Benefit>
          </ul>
        )}
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]">
          <Field
            label="Address other servers use"
            description="This server's public IP or host name. Use a private IP when all servers share a private network."
            error={touched ? problem : null}
          >
            <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value.trim())} placeholder="203.0.113.10" className="font-mono" autoComplete="off" />
            {options.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span className="text-xs text-muted">This server has:</span>
                {options.map((o) => (
                  <button
                    key={o.address}
                    type="button"
                    onClick={() => setEndpoint(o.address)}
                    className={cn(
                      "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs ring-1 transition-colors",
                      endpoint === o.address ? "bg-accent-soft text-accent-strong ring-accent/30" : "bg-surface-2 text-fg-2 ring-line hover:bg-hover",
                    )}
                  >
                    <span className="font-mono">{o.address}</span>
                    <span className="text-faint">{o.label}</span>
                  </button>
                ))}
              </div>
            )}
          </Field>
          <Field label="UDP port" error={touched ? portProblem : null}>
            <Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" className="font-mono" />
          </Field>
        </div>
        <p className="flex items-start gap-2 rounded-xl bg-surface-2 px-3.5 py-3 text-xs leading-relaxed text-muted">
          <Cable className="mt-px size-3.5 flex-none text-faint" />
          <span>
            Servers connect to each other on UDP port <span className="font-mono text-fg-2">{port || MESH_DEFAULT_PORT}</span>. The server&apos;s own firewall is opened
            automatically; if your provider has a cloud firewall, allow that port there too.
          </span>
        </p>
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
    <li className="flex flex-col gap-1.5 rounded-xl border border-line bg-surface-2/60 p-3.5">
      <span className="flex items-center gap-2 text-[13px] font-medium text-fg [&_svg]:size-4 [&_svg]:text-accent">
        {icon}
        {title}
      </span>
      <span className="text-xs leading-relaxed text-muted">{children}</span>
    </li>
  );
}

function Joined({ mesh, serverId, serverName, onEdit, refresh }: { mesh: MeshOverview; serverId: string; serverName: string; onEdit: () => void; refresh: () => void }) {
  const confirm = useConfirm();
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
            <span className="font-mono break-all">{mesh.endpoint ? `${mesh.endpoint}:${mesh.port}` : "—"}</span>
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
                await confirm({
                  title: `Remove ${serverName} from the private network?`,
                  description: "Services on other servers can no longer reach services on this server by their private names, and the other way around.",
                  confirmLabel: "Leave network",
                  danger: true,
                })
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

function Peers({ peers, outside }: { peers: MeshPeerView[]; outside: number }) {
  const now = useNow();
  return (
    <Card>
      <CardHeader title="Servers" description="Other servers in the private network and the link to each of them." />
      {peers.length === 0 ? (
        <EmptyState
          icon={<Waypoints />}
          title="No other servers yet"
          description={outside > 0 ? "Open another server and turn on its private network to connect the two." : "Add another server, then turn on its private network."}
          action={
            <Link href="/servers" className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
              Servers <ArrowRight className="size-3.5" />
            </Link>
          }
        />
      ) : (
        <ul className="divide-y divide-line">
          {peers.map((p) => {
            const state = linkState(p, now);
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
                      : state === "error"
                        ? "Not set up"
                        : p.latestHandshake
                          ? `No contact since ${handshakeAge(p.latestHandshake, (now ?? Date.now()) / 1000)}`
                          : "Waiting for contact"}
                  </span>
                  <span className="text-faint tabular-nums">
                    {state === "connected"
                      ? `${handshakeAge(p.latestHandshake, (now ?? Date.now()) / 1000)} · ↓ ${formatBytes(p.rx)} ↑ ${formatBytes(p.tx)}`
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
              {services === 0 ? "No services run on this server yet." : "None: no environment here also runs on another server of the network."}
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
