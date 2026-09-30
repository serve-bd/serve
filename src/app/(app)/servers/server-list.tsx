"use client";

import Link from "next/link";
import { ArrowRight, Plus, Server } from "lucide-react";
import { Badge, Card, EmptyState } from "@/components/ui/misc";
import { StatusLabel } from "@/components/ui/status";
import type { ServerInfo, ServerStatus } from "@/server/db/schema";
import { cn, formatBytes } from "@/lib/utils";
import { ProductName } from "@/components/brand";

type Row = {
  id: string;
  name: string;
  description: string | null;
  host: string;
  /** No public IP: reached through its tunnel. */
  tunnel: boolean;
  port: number;
  username: string;
  isLocal: boolean;
  /** In the private network. */
  mesh: boolean;
  status: ServerStatus;
  statusMessage: string | null;
  info: ServerInfo;
  publicIp: string | null;
  lastSeenAt: string | null;
  services: number;
  running: number;
  /** Open resource alerts (disk, memory, CPU). */
  alerts: number;
};

export function ServerList({ servers }: { servers: Row[] }) {
  if (servers.length <= 1 && servers[0]?.isLocal) {
    return (
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {servers.map((s) => (
            <ServerCard key={s.id} server={s} />
          ))}
          <AddCard />
        </div>
        <Card>
          <EmptyState
            icon={<Server />}
            title="Run services on more machines"
            description={
              <>
                Add a Linux server with SSH access. <ProductName /> installs Docker if needed, starts its proxy there, and lets you deploy to it like this one.
              </>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {servers.map((s) => (
        <ServerCard key={s.id} server={s} />
      ))}
      <AddCard />
    </div>
  );
}

function AddCard() {
  return (
    <Link
      href="/servers/new"
      className="group flex min-h-[188px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong text-muted transition-colors hover:border-accent/50 hover:bg-accent-soft/40 hover:text-fg"
    >
      <span className="flex size-10 items-center justify-center rounded-xl bg-surface-2 ring-1 ring-line transition-colors group-hover:bg-accent group-hover:text-accent-fg group-hover:ring-accent">
        <Plus className="size-5" />
      </span>
      <span className="text-[13px] font-medium">Add server</span>
    </Link>
  );
}

function ServerCard({ server: s }: { server: Row }) {
  const facts = [s.info.os, s.info.cpus ? `${s.info.cpus} CPU` : null, s.info.memory ? formatBytes(s.info.memory, 0) : null].filter(Boolean);
  const problem = s.status === "unreachable" || s.status === "error";
  return (
    <Link
      href={`/servers/${s.id}`}
      className={cn(
        "group flex flex-col overflow-hidden rounded-2xl border bg-surface shadow-sm transition-[border-color,box-shadow] hover:shadow-md",
        problem ? "border-bad/30 hover:border-bad/50" : "border-line hover:border-line-strong",
      )}
    >
      <div className="flex items-start gap-3 p-4">
        <span className={cn("flex size-10 flex-none items-center justify-center rounded-xl", s.isLocal ? "bg-fg text-bg" : "bg-surface-2 text-fg-2 ring-1 ring-line")}>
          <Server className="size-5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[15px] font-semibold text-fg">{s.name}</span>
            {s.isLocal && <Badge tone="accent">This server</Badge>}
            {s.mesh && <Badge>Private network</Badge>}
          </div>
          <span className="truncate font-mono text-[12px] text-muted">
            {s.isLocal ? (s.publicIp ?? "Local Docker") : s.tunnel ? `${s.username}@${s.host} · via tunnel` : `${s.username}@${s.host}${s.port === 22 ? "" : `:${s.port}`}`}
          </span>
        </div>
        <ArrowRight className="size-4 flex-none text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-fg-2" />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 px-4 pb-4">
        <StatusLabel status={s.status} kind="server" className="text-xs" />
        {s.statusMessage && s.status !== "ready" ? (
          <p className={cn("line-clamp-2 text-xs leading-relaxed", problem ? "text-bad" : "text-muted")}>{s.statusMessage}</p>
        ) : (
          <p className="truncate text-xs text-muted">
            {facts.length ? facts.join(" · ") : s.description || (s.isLocal ? "Runs this dashboard" : "Validate to read system details")}
          </p>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-xs text-muted">
        <span>{s.services === 0 ? "No services" : `${s.running}/${s.services} service${s.services === 1 ? "" : "s"} running`}</span>
        {s.alerts > 0 ? (
          <span className="inline-flex items-center gap-1.5 font-medium text-warn">
            <span className="size-1.5 rounded-full bg-warn" />
            {s.alerts} alert{s.alerts === 1 ? "" : "s"}
          </span>
        ) : (
          s.info.docker && <span className="font-mono text-[11px] text-faint">Docker {s.info.docker}</span>
        )}
      </div>
    </Link>
  );
}
