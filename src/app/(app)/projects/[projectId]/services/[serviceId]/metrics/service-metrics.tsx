"use client";

import { counterRate } from "@/lib/counter-rate";
import * as React from "react";
import useSWR from "swr";
import { AreaChart } from "@/components/charts/area-chart";
import { Card } from "@/components/ui/misc";
import { formatBytes, cn } from "@/lib/utils";
import { RequestLog } from "./request-log";

type Series = { t: number; cpu: number; memory: number; memoryLimit: number; netRx: number | null; netTx: number | null }[];

const ranges = [
  { hours: 1, label: "1h" },
  { hours: 6, label: "6h" },
  { hours: 24, label: "24h" },
  { hours: 48, label: "48h" },
  { hours: 168, label: "7d" },
];

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

type Req = {
  series: { t: number; requests: number; s2xx: number; s3xx: number; s4xx: number; s5xx: number; bytes: number; avgMs: number }[];
  totals: { requests: number; errors: number; bytes: number; avgMs: number };
};

function compact(n: number) {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

function StatusBars({ series, picked, setPicked }: { series: Req["series"]; picked: number | null; setPicked: React.Dispatch<React.SetStateAction<number | null>> }) {
  // Hovering a bar shows its numbers; a tap or click keeps them (phones have no hover), and the
  // request log below shows that bar's requests.
  const [hovered, setHovered] = React.useState<number | null>(null);
  const max = Math.max(1, ...series.map((p) => p.requests));
  if (series.length === 0) return <div className="flex h-[120px] items-center justify-center text-xs text-faint">No requests yet</div>;
  const shown = series.find((p) => p.t === (hovered ?? picked));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-[120px] items-end gap-px" onPointerLeave={() => setHovered(null)}>
        {series.map((p) => (
          <button
            key={p.t}
            type="button"
            aria-label={`${new Date(p.t).toLocaleString()}: ${p.requests} requests`}
            aria-pressed={picked === p.t}
            onPointerEnter={(e) => e.pointerType === "mouse" && setHovered(p.t)}
            onClick={() => setPicked((t) => (t === p.t ? null : p.t))}
            className="group relative flex h-full flex-1 cursor-pointer flex-col justify-end rounded-t-[2px] outline-none focus-visible:bg-fg/[0.06]"
          >
            <div
              className={cn("flex flex-col overflow-hidden rounded-t-[2px] transition-opacity", shown && shown.t !== p.t ? "opacity-40" : "group-hover:opacity-80")}
              style={{ height: `${(p.requests / max) * 100}%` }}
            >
              <div className="bg-bad" style={{ flex: p.s5xx }} />
              <div className="bg-warn" style={{ flex: p.s4xx }} />
              <div className="bg-info" style={{ flex: p.s3xx }} />
              <div className="bg-ok" style={{ flex: p.s2xx }} />
            </div>
          </button>
        ))}
      </div>
      <div className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-muted">
        {shown ? (
          <>
            <span className="font-medium text-fg">{new Date(shown.t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
            <span>{shown.requests} requests</span>
            {(
              [
                ["2xx", shown.s2xx, "bg-ok"],
                ["3xx", shown.s3xx, "bg-info"],
                ["4xx", shown.s4xx, "bg-warn"],
                ["5xx", shown.s5xx, "bg-bad"],
              ] as const
            )
              .filter(([, n]) => n > 0)
              .map(([l, n, c]) => (
                <span key={l} className="flex items-center gap-1.5">
                  <span className={cn("size-2 rounded-sm", c)} />
                  {n} {l}
                </span>
              ))}
            {shown.requests > 0 && <span>{Math.round(shown.avgMs)} ms avg</span>}
          </>
        ) : (
          <span className="text-faint">Hover or tap a bar for its numbers.</span>
        )}
      </div>
    </div>
  );
}

export function ServiceMetrics({
  serviceId,
  memoryLimit,
  hasDomains,
  resources,
  requestLog,
}: {
  serviceId: string;
  memoryLimit: number | null;
  hasDomains: boolean;
  /** The request log of the service: whether it is on, what it keeps, where to set it up. */
  requestLog: { enabled: boolean; statuses: number[]; settingsHref: string } | null;
  /** Its server records CPU and memory; off shows request counts only. */
  resources: boolean;
}) {
  const [hours, setHours] = React.useState(6);
  const { data } = useSWR<{ series: Series }>(resources ? `/api/metrics?scope=${serviceId}&hours=${hours}` : null, { refreshInterval: 15000 });
  const series = data?.series ?? [];
  const last = series.at(-1);
  const rx = counterRate(series, "netRx");
  const tx = counterRate(series, "netTx");
  const limit = memoryLimit ? memoryLimit * 1024 * 1024 : last?.memoryLimit || undefined;
  // Docker reports a limit (the host's RAM at least) whenever it can measure memory; none means it cannot.
  // Docker on some servers never reports memory (limit 0); judged by the latest point, so a change mid-window shows.
  const memUnknown = series.length > 0 && !series.at(-1)!.memoryLimit;
  const { data: req } = useSWR<Req>(hasDomains ? `/api/services/${serviceId}/requests?hours=${hours}` : null, { refreshInterval: 30000 });
  const [picked, setPicked] = React.useState<number | null>(null);
  const points = req?.series ?? [];
  const step = points.length > 1 ? points[1].t - points[0].t : 60_000;
  // A bar picked in another range is not on the chart any more.
  React.useEffect(() => setPicked(null), [hours]);

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
      {hasDomains && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
          <Panel title="Requests" value={req ? compact(req.totals.requests) : "—"}>
            <StatusBars series={points} picked={picked} setPicked={setPicked} />
            <div className="flex flex-wrap gap-4 text-xs text-muted">
              {[
                ["2xx", "bg-ok"],
                ["3xx", "bg-info"],
                ["4xx", "bg-warn"],
                ["5xx", "bg-bad"],
              ].map(([l, c]) => (
                <span key={l} className="flex items-center gap-1.5">
                  <span className={cn("size-2 rounded-sm", c)} />
                  {l}
                </span>
              ))}
            </div>
          </Panel>
          <div className="grid gap-4">
            <Panel title="Avg response" value={req ? `${Math.round(req.totals.avgMs)} ms` : "—"}>
              <AreaChart data={(req?.series ?? []).map((p) => ({ t: p.t, v: p.avgMs }))} color="var(--accent)" format={(v) => `${Math.round(v)} ms`} height={56} />
            </Panel>
            <Panel title="Server errors" value={req ? compact(req.totals.errors) : "—"}>
              <p className="text-xs text-muted">
                {req?.totals.requests
                  ? `${((req.totals.errors / req.totals.requests) * 100).toFixed(2)}% of requests · ${formatBytes(req.totals.bytes)} sent`
                  : "5xx responses from this service."}
              </p>
            </Panel>
          </div>
        </div>
      )}
      {hasDomains && requestLog && (
        <RequestLog
          serviceId={serviceId}
          enabled={requestLog.enabled}
          statuses={requestLog.statuses}
          settingsHref={requestLog.settingsHref}
          window={picked !== null ? { from: picked, to: picked + step } : null}
          onClearWindow={() => setPicked(null)}
        />
      )}
      {!resources ? (
        <p className="px-1 text-xs text-muted">
          Its server does not collect metrics, so CPU, memory and network use are not shown. Admins turn them on in the server&apos;s settings.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="CPU" value={last ? `${last.cpu.toFixed(1)}%` : "—"}>
              <AreaChart data={series.map((p) => ({ t: p.t, v: p.cpu }))} format={(v) => `${v.toFixed(1)}%`} height={160} />
            </Panel>
            <Panel title="Memory" value={last && !memUnknown ? formatBytes(last.memory) : "—"}>
              {memUnknown ? (
                <p className="flex h-[160px] items-center justify-center px-4 text-center text-[13px] text-muted">
                  Docker on this server does not report memory use. This happens when Docker runs inside another container.
                </p>
              ) : (
                <AreaChart data={series.map((p) => ({ t: p.t, v: p.memory }))} color="var(--info)" max={limit} format={(v) => formatBytes(v)} height={160} />
              )}
            </Panel>
            <Panel title="Network in" value={rx.at(-1)?.v != null ? `${formatBytes(rx.at(-1)!.v!)}/s` : "—"}>
              <AreaChart data={rx} color="var(--ok)" format={(v) => `${formatBytes(v)}/s`} height={120} />
            </Panel>
            <Panel title="Network out" value={tx.at(-1)?.v != null ? `${formatBytes(tx.at(-1)!.v!)}/s` : "—"}>
              <AreaChart data={tx} color="var(--warn)" format={(v) => `${formatBytes(v)}/s`} height={120} />
            </Panel>
          </div>
          <p className="text-xs text-faint">Sampled every 30 seconds across all containers of this service.</p>
        </>
      )}
    </div>
  );
}
