"use client";

import Link from "next/link";
import { Server as ServerIcon } from "lucide-react";
import { AreaChart } from "@/components/charts/area-chart";
import { StatusDot } from "@/components/ui/status";
import { cn } from "@/lib/utils";

export type ServerCardData = {
  id: string;
  name: string;
  host: string;
  isLocal: boolean;
  status: string;
  services: number;
  running: number;
  /** Off: the card shows status only, no usage. */
  metricsEnabled: boolean;
  series: { t: number; cpu: number; memory: number; memoryLimit: number; disk: number | null; diskTotal: number | null }[];
};

const pct = (v: number | null | undefined, total: number | null | undefined) => (v != null && total ? (v / total) * 100 : null);

const MEMORY = "var(--chart-2, #a855f7)";

function Stat({ label, value, color }: { label: string; value: number | null; color?: string }) {
  const tone = value == null ? "text-faint" : value > 90 ? "text-bad" : value > 75 ? "text-warn" : "text-fg";
  return (
    <div className="flex flex-col">
      <span className="flex items-center gap-1.5 text-[11px] text-faint">
        {color && <span className="size-1.5 rounded-full" style={{ background: color }} />}
        {label}
      </span>
      <span className={cn("text-[15px] font-medium tabular-nums", tone)}>{value == null ? "—" : `${value.toFixed(0)}%`}</span>
    </div>
  );
}

/** One card per server: status, live usage and a 6 hour CPU / memory trend. */
export function ServerCards({ servers }: { servers: ServerCardData[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {servers.map((s) => {
        const last = s.series.at(-1);
        const status = s.isLocal ? "running" : s.status === "ready" ? "running" : s.status === "validating" ? "starting" : s.status === "pending" ? "idle" : "failed";
        return (
          <Link
            key={s.id}
            href={`/servers/${s.id}`}
            className="group flex flex-col overflow-hidden rounded-2xl border border-line bg-surface transition-colors hover:border-line-strong"
          >
            <div className="flex items-start gap-3 p-4 pb-3">
              <span className="flex size-9 flex-none items-center justify-center rounded-xl bg-surface-2 text-fg-2">
                <ServerIcon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[14px] font-medium text-fg">{s.name}</span>
                  <StatusDot status={status} />
                </div>
                <p className="truncate text-xs text-muted">
                  {s.isLocal ? "The server this dashboard runs on" : s.host} · {s.running}/{s.services} running
                </p>
              </div>
            </div>
            {s.metricsEnabled ? (
              <>
                <div className="grid grid-cols-3 gap-2 px-4 pb-3">
                  <Stat label="CPU" value={last?.cpu ?? null} color="var(--accent)" />
                  <Stat label="Memory" value={pct(last?.memory, last?.memoryLimit)} color={MEMORY} />
                  <Stat label="Disk" value={pct(last?.disk, last?.diskTotal)} />
                </div>
                <div className="relative mt-auto h-14 border-t border-line">
                  <AreaChart
                    data={s.series.map((p) => ({ t: p.t, v: pct(p.memory, p.memoryLimit) }))}
                    color={MEMORY}
                    max={100}
                    height={56}
                    format={(v) => `Memory ${v.toFixed(0)}%`}
                    className="absolute inset-0"
                  />
                  <AreaChart data={s.series.map((p) => ({ t: p.t, v: p.cpu }))} max={100} height={56} format={(v) => `CPU ${v.toFixed(0)}%`} className="absolute inset-0" />
                </div>
              </>
            ) : (
              <p className="mt-auto border-t border-line px-4 py-3 text-xs text-faint">Metrics are off for this server.</p>
            )}
          </Link>
        );
      })}
    </div>
  );
}
