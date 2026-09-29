"use client";

import useSWR from "swr";
import { Cpu, HardDrive, MemoryStick } from "lucide-react";
import { AreaChart, Meter } from "@/components/charts/area-chart";
import { Card } from "@/components/ui/misc";
import { formatBytes } from "@/lib/utils";

type MetricsResponse = {
  series: { t: number; cpu: number; memory: number; memoryLimit: number; disk: number | null; diskTotal: number | null }[];
  now: {
    cpu: number;
    cores: number;
    memory: { total: number; used: number };
    disk: { total: number; used: number };
    load: number[];
    uptime: number;
  } | null;
};

function Stat({
  icon,
  label,
  value,
  sub,
  meter,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  meter: [number, number];
}) {
  return (
    <div className="flex flex-col gap-2.5 p-4">
      <div className="flex items-center gap-2 text-[12px] font-medium text-muted [&_svg]:size-3.5">
        {icon}
        {label}
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-display text-[22px] font-semibold tabular-nums text-fg">{value}</span>
        <span className="text-xs text-faint tabular-nums">{sub}</span>
      </div>
      <Meter value={meter[0]} max={meter[1]} />
    </div>
  );
}

export function ServerStats() {
  const { data } = useSWR<MetricsResponse>("/api/metrics?scope=server&hours=6", { refreshInterval: 10_000 });
  const now = data?.now;
  const uptimeDays = now ? Math.floor(now.uptime / 86400) : 0;
  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-1 divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Stat
          icon={<Cpu />}
          label="CPU"
          value={now ? `${now.cpu.toFixed(0)}%` : "—"}
          sub={now ? `${now.cores} cores · load ${now.load[0].toFixed(2)}` : ""}
          meter={[now?.cpu ?? 0, 100]}
        />
        <Stat
          icon={<MemoryStick />}
          label="Memory"
          value={now ? formatBytes(now.memory.used) : "—"}
          sub={now ? `of ${formatBytes(now.memory.total, 0)}` : ""}
          meter={[now?.memory.used ?? 0, now?.memory.total ?? 1]}
        />
        <Stat
          icon={<HardDrive />}
          label="Disk"
          value={now ? formatBytes(now.disk.used) : "—"}
          sub={now ? `of ${formatBytes(now.disk.total, 0)}` : ""}
          meter={[now?.disk.used ?? 0, now?.disk.total ?? 1]}
        />
      </div>
      <div className="grid grid-cols-1 gap-px border-t border-line bg-line sm:grid-cols-2">
        <div className="bg-surface px-4 pt-3 pb-2">
          <p className="mb-1 text-[11px] font-medium tracking-wide text-faint uppercase">CPU · 6h</p>
          <AreaChart data={(data?.series ?? []).map((p) => ({ t: p.t, v: p.cpu }))} max={100} height={80} format={(v) => `${v.toFixed(1)}%`} />
        </div>
        <div className="bg-surface px-4 pt-3 pb-2">
          <p className="mb-1 text-[11px] font-medium tracking-wide text-faint uppercase">Memory · 6h</p>
          <AreaChart
            data={(data?.series ?? []).map((p) => ({ t: p.t, v: p.memory }))}
            max={data?.series.at(-1)?.memoryLimit || undefined}
            color="var(--info)"
            height={80}
            format={(v) => formatBytes(v)}
          />
        </div>
      </div>
      {now && (
        <div className="border-t border-line bg-surface-2 px-4 py-2 text-[11px] text-faint">
          Up {uptimeDays > 0 ? `${uptimeDays}d ` : ""}
          {Math.floor((now.uptime % 86400) / 3600)}h
        </div>
      )}
    </Card>
  );
}
