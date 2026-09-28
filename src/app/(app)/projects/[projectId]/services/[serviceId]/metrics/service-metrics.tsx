"use client";

import * as React from "react";
import useSWR from "swr";
import { AreaChart } from "@/components/charts/area-chart";
import { Card } from "@/components/ui/misc";
import { formatBytes, cn } from "@/lib/utils";

type Series = { t: number; cpu: number; memory: number; memoryLimit: number; netRx: number | null; netTx: number | null }[];

const ranges = [
  { hours: 1, label: "1h" },
  { hours: 6, label: "6h" },
  { hours: 24, label: "24h" },
  { hours: 48, label: "48h" },
];

function rate(series: Series, key: "netRx" | "netTx") {
  const out: { t: number; v: number | null }[] = [];
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1][key];
    const b = series[i][key];
    const dt = (series[i].t - series[i - 1].t) / 1000;
    out.push({ t: series[i].t, v: a !== null && b !== null && b >= a && dt > 0 ? (b - a) / dt : null });
  }
  return out;
}

function Panel({ title, value, children }: { title: string; value: string; children: React.ReactNode }) {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-muted">{title}</span>
        <span className="text-[20px] font-semibold tabular-nums text-fg">{value}</span>
      </div>
      {children}
    </Card>
  );
}

export function ServiceMetrics({ serviceId, memoryLimit }: { serviceId: string; memoryLimit: number | null }) {
  const [hours, setHours] = React.useState(6);
  const { data } = useSWR<{ series: Series }>(`/api/metrics?scope=${serviceId}&hours=${hours}`, { refreshInterval: 15000 });
  const series = data?.series ?? [];
  const last = series.at(-1);
  const rx = rate(series, "netRx");
  const tx = rate(series, "netTx");
  const limit = memoryLimit ? memoryLimit * 1024 * 1024 : last?.memoryLimit || undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <div className="flex gap-1 rounded-xl bg-sunken p-1">
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
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="CPU" value={last ? `${last.cpu.toFixed(1)}%` : "—"}>
          <AreaChart data={series.map((p) => ({ t: p.t, v: p.cpu }))} format={(v) => `${v.toFixed(1)}%`} height={160} />
        </Panel>
        <Panel title="Memory" value={last ? formatBytes(last.memory) : "—"}>
          <AreaChart data={series.map((p) => ({ t: p.t, v: p.memory }))} color="var(--info)" max={limit} format={(v) => formatBytes(v)} height={160} />
        </Panel>
        <Panel title="Network in" value={rx.at(-1)?.v != null ? `${formatBytes(rx.at(-1)!.v!)}/s` : "—"}>
          <AreaChart data={rx} color="var(--ok)" format={(v) => `${formatBytes(v)}/s`} height={120} />
        </Panel>
        <Panel title="Network out" value={tx.at(-1)?.v != null ? `${formatBytes(tx.at(-1)!.v!)}/s` : "—"}>
          <AreaChart data={tx} color="var(--warn)" format={(v) => `${formatBytes(v)}/s`} height={120} />
        </Panel>
      </div>
      <p className="text-xs text-faint">Sampled every 30 seconds across all containers of this service.</p>
    </div>
  );
}
