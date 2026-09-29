"use client";

import * as React from "react";
import Link from "next/link";
import useSWR from "swr";
import { Activity, Clock, Cpu, Gauge, HardDrive, Info, MemoryStick } from "lucide-react";
import { AreaChart, Meter } from "@/components/charts/area-chart";
import { Card, CardHeader, EmptyState } from "@/components/ui/misc";
import { cn, formatBytes } from "@/lib/utils";

type Point = { t: number; cpu: number; memory: number; memoryLimit: number; disk: number | null; diskTotal: number | null };
type Now = { cpu: number; cores: number; memory: { total: number; used: number }; disk: { total: number; used: number }; load: number[]; uptime: number };
type Top = { id: string; name: string; type: string; projectId: string; projectName: string; organizationName: string; cpu: number; memory: number; memoryLimit: number | null };

const ranges = [
  { hours: 1, label: "1h" },
  { hours: 6, label: "6h" },
  { hours: 24, label: "24h" },
  { hours: 168, label: "7d" },
];

function uptime(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function Live({ icon, label, value, sub, meter }: { icon: React.ReactNode; label: string; value: string; sub?: string; meter?: [number, number] }) {
  return (
    <div className="flex flex-col gap-2 bg-surface px-5 py-4">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted [&_svg]:size-3.5">
        {icon}
        {label}
      </span>
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex-none text-[20px] font-semibold whitespace-nowrap tabular-nums text-fg">{value}</span>
        {sub && <span className="min-w-0 truncate text-[11px] text-faint tabular-nums">{sub}</span>}
      </div>
      {meter && <Meter value={meter[0]} max={meter[1]} />}
    </div>
  );
}

function Panel({ title, value, children }: { title: string; value: string; children: React.ReactNode }) {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium text-muted">{title}</span>
        <span className="text-[18px] font-semibold tabular-nums text-fg">{value}</span>
      </div>
      {children}
    </Card>
  );
}

function TopList({ services, metric }: { services: Top[]; metric: "cpu" | "memory" }) {
  const sorted = [...services].sort((a, b) => b[metric] - a[metric]).slice(0, 6);
  const max = Math.max(metric === "cpu" ? 1 : 1024 * 1024, ...sorted.map((s) => s[metric]));
  return (
    <div className="flex flex-col divide-y divide-line">
      {sorted.map((s) => (
        <Link key={s.id} href={`/projects/${s.projectId}/services/${s.id}/metrics`} className="group flex flex-col gap-1.5 px-5 py-2.5 transition-colors hover:bg-hover">
          <div className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="min-w-0 truncate">
              <span className="font-medium text-fg group-hover:text-accent">{s.name}</span>
              <span className="text-faint"> · {s.projectName}</span>
            </span>
            <span className="flex-none tabular-nums text-fg-2">{metric === "cpu" ? `${s.cpu.toFixed(1)}%` : formatBytes(s.memory)}</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-sunken">
            <div className={cn("h-full rounded-full", metric === "cpu" ? "bg-accent" : "bg-info")} style={{ width: `${Math.max(2, (s[metric] / max) * 100)}%` }} />
          </div>
        </Link>
      ))}
    </div>
  );
}

export function ServerMetrics({ retentionHours }: { retentionHours: number }) {
  const [hours, setHours] = React.useState(6);
  const { data } = useSWR<{ series: Point[]; now: Now | null }>(`/api/metrics?scope=server&hours=${hours}`, { refreshInterval: 10_000 });
  const { data: top } = useSWR<{ services: Top[] }>("/api/server/metrics/top", { refreshInterval: 30_000 });
  const series = data?.series ?? [];
  const now = data?.now;
  const last = series.at(-1);
  const diskTotal = now?.disk.total ?? last?.diskTotal ?? undefined;

  return (
    <div className="flex flex-col gap-6">
      <Card className="overflow-hidden">
        <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2 lg:grid-cols-4">
          <Live icon={<Cpu />} label="CPU" value={now ? `${now.cpu.toFixed(0)}%` : "—"} sub={now ? `${now.cores} cores` : undefined} meter={[now?.cpu ?? 0, 100]} />
          <Live icon={<MemoryStick />} label="Memory" value={now ? formatBytes(now.memory.used) : "—"} sub={now ? `of ${formatBytes(now.memory.total, 0)}` : undefined} meter={[now?.memory.used ?? 0, now?.memory.total || 1]} />
          <Live icon={<HardDrive />} label="Disk" value={now ? formatBytes(now.disk.used) : "—"} sub={now ? `of ${formatBytes(now.disk.total, 0)}` : undefined} meter={[now?.disk.used ?? 0, now?.disk.total || 1]} />
          <Live
            icon={<Gauge />}
            label="Load average"
            value={now ? now.load[0].toFixed(2) : "—"}
            sub={now ? `${now.load[1].toFixed(2)} · ${now.load[2].toFixed(2)}` : undefined}
            meter={[now?.load[0] ?? 0, now?.cores || 1]}
          />
        </div>
        {now && (
          <div className="flex items-center gap-1.5 border-t border-line bg-surface-2/60 px-5 py-2 text-[11.5px] text-muted">
            <Clock className="size-3" /> Up {uptime(now.uptime)}
          </div>
        )}
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-1.5 text-xs text-muted">
          {hours > retentionHours ? (
            <>
              <Info className="size-3.5 flex-none text-warn" />
              <span>
                Only the last {retentionHours} hours are kept.{" "}
                <Link href="/server/advanced" className="text-accent hover:underline">
                  Keep more history
                </Link>
              </span>
            </>
          ) : (
            "Sampled every 30 seconds."
          )}
        </p>
        <div className="flex gap-1 self-start rounded-xl bg-sunken p-1 sm:self-auto">
          {ranges.map((r) => (
            <button
              key={r.hours}
              type="button"
              onClick={() => setHours(r.hours)}
              className={cn("h-7 rounded-lg px-3 text-xs font-medium transition-all", hours === r.hours ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg")}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="CPU" value={last ? `${last.cpu.toFixed(1)}%` : "—"}>
          <AreaChart data={series.map((p) => ({ t: p.t, v: p.cpu }))} max={100} format={(v) => `${v.toFixed(1)}%`} height={160} />
        </Panel>
        <Panel title="Memory" value={last ? formatBytes(last.memory) : "—"}>
          <AreaChart data={series.map((p) => ({ t: p.t, v: p.memory }))} color="var(--info)" max={last?.memoryLimit || undefined} format={(v) => formatBytes(v)} height={160} />
        </Panel>
      </div>
      <Panel title="Disk" value={last?.disk != null ? `${formatBytes(last.disk)}${diskTotal ? ` of ${formatBytes(diskTotal, 0)}` : ""}` : "—"}>
        <AreaChart data={series.map((p) => ({ t: p.t, v: p.disk }))} color="var(--warn)" max={diskTotal} format={(v) => formatBytes(v)} height={120} />
      </Panel>

      <Card className="overflow-hidden">
        <CardHeader title="Top services" description="Current usage from the latest samples." />
        {!top ? (
          <div className="h-40 animate-pulse bg-surface-2/40" />
        ) : top.services.length === 0 ? (
          <EmptyState icon={<Activity />} title="No running services" description="Usage shows up here once services are running." />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 md:divide-x md:divide-line">
            <div className="flex flex-col py-2">
              <p className="px-5 pt-1 pb-1.5 text-[11px] font-medium tracking-wide text-faint uppercase">By CPU</p>
              <TopList services={top.services} metric="cpu" />
            </div>
            <div className="flex flex-col border-t border-line py-2 md:border-t-0">
              <p className="px-5 pt-1 pb-1.5 text-[11px] font-medium tracking-wide text-faint uppercase">By memory</p>
              <TopList services={top.services} metric="memory" />
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
