"use client";

import * as React from "react";
import Link from "next/link";
import useSWR from "swr";
import { Box, Boxes, HardDrive, Layers, MoreHorizontal, Network, Play, RotateCw, Search, Square } from "lucide-react";
import { Badge, Card, EmptyState, TimeAgo } from "@/components/ui/misc";
import { Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { controlUnmanagedContainer } from "@/server/actions/server-resources";
import { cn, formatBytes } from "@/lib/utils";
import type { ContainerKind, ContainerRow } from "@/server/servers/resources";

type Filter = "all" | "serve" | "unmanaged";
type Stats = Record<string, { cpu: number; memory: number; memoryLimit: number | null }>;

const stateColor: Record<string, string> = {
  running: "var(--ok)",
  restarting: "var(--warn)",
  paused: "var(--warn)",
  created: "var(--idle)",
  exited: "var(--idle)",
  dead: "var(--bad)",
};

const kindBadge: Record<ContainerKind, { label: string; tone: "accent" | "neutral" | "info" }> = {
  system: { label: "Managed", tone: "accent" },
  service: { label: "Service", tone: "info" },
  unmanaged: { label: "Unmanaged", tone: "neutral" },
};

function Tile({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="flex flex-col gap-1.5 bg-surface px-5 py-4">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted [&_svg]:size-3.5">
        {icon}
        {label}
      </span>
      <span className="text-[20px] font-semibold tabular-nums text-fg">{value}</span>
      {sub && <span className="text-[11px] text-faint">{sub}</span>}
    </div>
  );
}

function Usage({ stats, running }: { stats: Stats[string] | undefined; running: boolean }) {
  if (!running) return <span className="text-faint">—</span>;
  if (!stats) return <span className="inline-block h-3 w-16 animate-pulse rounded bg-sunken" />;
  return (
    <span className="tabular-nums">
      <span className="text-fg-2">{stats.cpu.toFixed(1)}%</span>
      <span className="text-faint"> · </span>
      <span className="text-fg-2">{formatBytes(stats.memory)}</span>
    </span>
  );
}

export function ResourcesView({ serverId, containers, summary }: { serverId: string; containers: ContainerRow[]; summary: { images: number; volumes: number; networks: number } }) {
  const [filter, setFilter] = React.useState<Filter>("all");
  const [query, setQuery] = React.useState("");
  const { data } = useSWR<{ stats: Stats }>(`/api/servers/${serverId}/resources/stats`, { refreshInterval: 10_000 });
  const stats = data?.stats ?? {};
  const confirm = useConfirm();
  const control = useAction(controlUnmanagedContainer);

  const running = containers.filter((c) => c.state === "running").length;
  const counts = {
    all: containers.length,
    serve: containers.filter((c) => c.kind !== "unmanaged").length,
    unmanaged: containers.filter((c) => c.kind === "unmanaged").length,
  };
  const q = query.trim().toLowerCase();
  const visible = containers.filter((c) => {
    if (filter === "serve" && c.kind === "unmanaged") return false;
    if (filter === "unmanaged" && c.kind !== "unmanaged") return false;
    if (!q) return true;
    return [c.name, c.image, c.service?.name, c.service?.projectName, c.role].some((v) => v?.toLowerCase().includes(q));
  });
  const totals = Object.values(stats).reduce((a, s) => ({ cpu: a.cpu + s.cpu, memory: a.memory + s.memory }), { cpu: 0, memory: 0 });

  return (
    <div className="flex flex-col gap-6">
      <Card className="overflow-hidden">
        <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
          <Tile
            icon={<Box />}
            label="Containers"
            value={
              <>
                {running}
                <span className="text-[14px] font-medium text-faint"> / {containers.length}</span>
              </>
            }
            sub={data ? `${totals.cpu.toFixed(0)}% CPU · ${formatBytes(totals.memory)}` : "running"}
          />
          <Tile icon={<Layers />} label="Images" value={summary.images} />
          <Tile icon={<HardDrive />} label="Volumes" value={summary.volumes} />
          <Tile icon={<Network />} label="Networks" value={summary.networks} />
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="flex gap-1 self-start rounded-xl bg-sunken p-1">
            {(["all", "serve", "unmanaged"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-all",
                  filter === f ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
                )}
              >
                {f === "all" ? "All" : f === "serve" ? "Managed" : "Unmanaged"}
                <span className="text-faint tabular-nums">{counts[f]}</span>
              </button>
            ))}
          </div>
          <div className="relative sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search containers" className="h-8 pl-8 text-[13px]" />
          </div>
        </div>

        {visible.length === 0 ? (
          <EmptyState icon={<Boxes />} title="No containers" description={q ? "Nothing matches your search." : "No containers in this view."} />
        ) : (
          <>
            <div className="hidden grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_140px_100px_32px] gap-4 border-b border-line bg-surface-2/50 px-5 py-2 text-[11px] font-medium tracking-wide text-faint uppercase md:grid">
              <span>Container</span>
              <span>Image</span>
              <span>Usage</span>
              <span>Created</span>
              <span />
            </div>
            <div className="divide-y divide-line">
              {visible.map((c) => {
                const isRunning = c.state === "running";
                return (
                  <div
                    key={c.id}
                    className="grid grid-cols-[minmax(0,1fr)_32px] items-center gap-x-4 gap-y-1.5 px-4 py-3 sm:px-5 md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_140px_100px_32px]"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="mt-1.5 size-2 flex-none rounded-full" style={{ background: stateColor[c.state] ?? "var(--idle)" }} title={c.state} />
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-mono text-[12.5px] font-medium text-fg">{c.name}</span>
                          <Badge tone={kindBadge[c.kind].tone} className="flex-none">
                            {kindBadge[c.kind].label}
                          </Badge>
                        </div>
                        <span className="truncate text-xs text-muted">
                          {c.service ? (
                            <Link href={`/projects/${c.service.projectId}/services/${c.service.id}`} className="text-fg-2 hover:text-accent hover:underline">
                              {c.service.organizationName} / {c.service.projectName} / {c.service.name}
                              {c.composeService ? ` · ${c.composeService}` : ""}
                            </Link>
                          ) : (
                            c.role && <span className="capitalize">{c.role}</span>
                          )}
                          {(c.service || c.role) && <span className="text-faint"> · </span>}
                          {c.status}
                        </span>
                      </div>
                    </div>
                    <div className="col-start-2 row-start-1 md:col-start-5">
                      {c.kind === "unmanaged" && (
                        <Menu>
                          <MenuTrigger className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label={`Actions for ${c.name}`}>
                            <MoreHorizontal className="size-4" />
                          </MenuTrigger>
                          <MenuContent>
                            {isRunning ? (
                              <>
                                <MenuItem onClick={() => control.run({ serverId, id: c.id, action: "restart" })}>
                                  <RotateCw /> Restart
                                </MenuItem>
                                <MenuItem
                                  danger
                                  onClick={async () => {
                                    if (
                                      await confirm({
                                        title: `Stop ${c.name}?`,
                                        description: "This container is not managed here. It stays stopped until you or its restart policy start it again.",
                                        confirmLabel: "Stop container",
                                        danger: true,
                                      })
                                    )
                                      control.run({ serverId, id: c.id, action: "stop" });
                                  }}
                                >
                                  <Square /> Stop
                                </MenuItem>
                              </>
                            ) : (
                              <MenuItem onClick={() => control.run({ serverId, id: c.id, action: "start" })}>
                                <Play /> Start
                              </MenuItem>
                            )}
                          </MenuContent>
                        </Menu>
                      )}
                    </div>
                    <div className="col-span-2 flex min-w-0 flex-col gap-0.5 pl-5 md:col-span-1 md:col-start-2 md:row-start-1 md:pl-0">
                      <span className="truncate font-mono text-[11.5px] text-fg-2" title={c.image}>
                        {c.image}
                      </span>
                      {c.ports.length > 0 && <span className="truncate font-mono text-[11px] text-faint">{c.ports.join("  ")}</span>}
                    </div>
                    <div className="col-span-2 flex items-center gap-3 pl-5 text-xs md:col-span-1 md:col-start-3 md:row-start-1 md:pl-0">
                      <Usage stats={stats[c.id]} running={isRunning} />
                      <span className="text-faint md:hidden">·</span>
                      <span className="text-muted md:hidden">
                        <TimeAgo date={c.created} />
                      </span>
                    </div>
                    <span className="hidden text-xs text-muted md:col-start-4 md:row-start-1 md:block">
                      <TimeAgo date={c.created} />
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Card>
      <p className="text-xs text-faint">Every container on this Docker host. Usage refreshes every 10 seconds. Only unmanaged containers can be started or stopped here.</p>
    </div>
  );
}
