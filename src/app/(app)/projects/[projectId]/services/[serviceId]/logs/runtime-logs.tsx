"use client";

import { Select } from "@/components/ui/select";
import { RequestLog } from "../metrics/request-log";
import * as React from "react";
import { Pause, Play, Trash2 } from "lucide-react";
import { LogViewer, type LogLine } from "@/components/log-viewer";
import { Led } from "@/components/ui/status";
import { Tooltip } from "@/components/ui/tooltip";
import { useLatest } from "@/hooks/use-client";
import { cn } from "@/lib/utils";

type Incoming = { c: string; t: string; m: string; s: string | null; e: boolean };

/** Docker's RFC3339 timestamp with its fraction padded to nanoseconds, so two of them compare as strings. */
const sortable = (t: string) => t.replace(/(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/, (_, f: string | undefined, zone: string) => `.${(f ?? "").padEnd(9, "0")}${zone}`);

/** Merges a batch into the log in time order: the first lines of each container arrive one container at a time. */
function mergeByTime(prev: LogLine[], next: LogLine[]) {
  const merged = prev.concat(next);
  const last = prev.at(-1)?.time;
  if (!last || next.every((l) => !l.time || l.time >= last)) return merged;
  return merged
    .map((l, i) => ({ l, i }))
    .sort((a, b) => (a.l.time && b.l.time && a.l.time !== b.l.time ? (a.l.time < b.l.time ? -1 : 1) : a.i - b.i))
    .map((x) => x.l);
}

export function RuntimeLogs({
  serviceId,
  name,
  containers = [],
  replicas = false,
  labels,
  initialContainer = null,
  requestLog = null,
}: {
  serviceId: string;
  name: string;
  /** Compose service names, or replica numbers when `replicas` is set. */
  containers?: string[];
  replicas?: boolean;
  /**
   * Names for the tabs, by container (a database's: its own, its pooler and its replicas; an app's
   * replicas on several servers). A database's have no "all" tab: each log stands on its own.
   */
  labels?: Record<string, string>;
  initialContainer?: string | null;
  /** The service's request log, shown next to the app's output (null: no domain, no requests). */
  requestLog?: { enabled: boolean; statuses: number[]; settingsHref: string } | null;
}) {
  const [mode, setMode] = React.useState<"logs" | "requests">("logs");
  const [container, setContainer] = React.useState<string | null>(
    initialContainer && containers.includes(initialContainer) ? initialContainer : labels && !replicas ? (containers[0] ?? null) : null,
  );
  const [lines, setLines] = React.useState<LogLine[]>([]);
  const [connected, setConnected] = React.useState(false);
  // Why logs cannot stream right now (the server is unreachable, signed out, ...), shown instead of "Connecting".
  const [problem, setProblem] = React.useState<string | null>(null);
  const [paused, setPaused] = React.useState(false);
  const pausedRef = useLatest(paused);
  const buffer = React.useRef<LogLine[]>([]);

  React.useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout>;
    // Newest line of each container: a reconnect resumes each after it, keeping what is on screen.
    const last = new Map<string, string>();
    let resume = false;
    let failures = 0;
    let shown: string | null = null;
    const report = (message: string | null) => {
      setProblem(message);
      // Also in the log itself when there are lines on screen, once per new reason.
      if (message && message !== shown) buffer.current.push({ text: `— ${message}`, source: null, error: true });
      shown = message;
    };
    const connect = () => {
      const query = new URLSearchParams({ tail: "500" });
      if (container) query.set("container", container);
      if (resume) query.set("resume", "1");
      if (last.size) query.set("since", [...last].map(([id, t]) => `${id}:${t}`).join(","));
      resume = true;
      es = new EventSource(`/api/services/${serviceId}/logs?${query}`);
      es.onopen = () => setConnected(true);
      es.addEventListener("problem", (ev) => {
        const { message } = JSON.parse((ev as MessageEvent).data) as { message: string };
        setConnected(false);
        report(message);
        es?.close();
        retry = setTimeout(connect, 10_000);
      });
      es.addEventListener("logs", (ev) => {
        failures = 0;
        if (shown) report(null);
        const batch = JSON.parse((ev as MessageEvent).data) as Incoming[];
        for (const l of batch) {
          const prev = last.get(l.c);
          if (l.t && (!prev || sortable(l.t) > sortable(prev))) last.set(l.c, l.t);
        }
        buffer.current.push(...batch.map((l) => ({ text: l.m, time: l.t, source: l.s, error: l.e })));
        // Paused: keep only what the view would keep, not everything since the pause.
        if (buffer.current.length > 5000) buffer.current.splice(0, buffer.current.length - 5000);
      });
      es.addEventListener("info", (ev) => {
        const { message } = JSON.parse((ev as MessageEvent).data) as { message: string };
        if (shown) report(null);
        buffer.current.push({ text: `— ${message}`, source: null });
      });
      es.onerror = () => {
        setConnected(false);
        es?.close();
        failures++;
        // A blip retries quietly. Past that, say what is known instead of "Connecting" forever.
        if (!navigator.onLine) report("You are offline. The logs continue when the connection is back.");
        else if (failures >= 3) report("Cannot reach the dashboard to stream logs. Trying again…");
        retry = setTimeout(connect, failures >= 3 ? 10_000 : 3000);
      };
    };
    setLines([]);
    setProblem(null);
    buffer.current = [];
    connect();
    // Batch UI updates for smooth scrolling under heavy output.
    const flush = setInterval(() => {
      if (pausedRef.current || !buffer.current.length) return;
      const next = buffer.current.splice(0);
      setLines((prev) => {
        const merged = mergeByTime(prev, next);
        return merged.length > 5000 ? merged.slice(-5000) : merged;
      });
    }, 250);
    return () => {
      es?.close();
      clearTimeout(retry);
      clearInterval(flush);
    };
  }, [serviceId, container, pausedRef]);

  const viewer = (
    <LogViewer
      lines={lines}
      showTime
      filename={`${container ? `${name}-${(labels?.[container] ?? (replicas ? `replica-${container}` : container)).replace(/[^\w.-]+/g, "-").toLowerCase()}` : name}.log`}
      emptyText={problem ?? (connected ? "No output yet." : "Connecting…")}
      height="calc(100vh - 290px)"
      toolbar={
        <div className="flex items-center gap-1">
          <span className="mr-2 flex items-center gap-2 text-[11px] text-white/50">
            <Led color={connected ? "#30d158" : problem ? "#ff9f0a" : "#636366"} pulse={connected && !paused} />
            {paused ? "Paused" : connected ? "Live" : problem ? "Unavailable" : "Connecting"}
          </span>
          <Tooltip content={paused ? "Resume" : "Pause"}>
            <button type="button" onClick={() => setPaused((p) => !p)} className="rounded-md p-1.5 text-white/40 hover:bg-white/[0.08] hover:text-white/80">
              {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            </button>
          </Tooltip>
          <Tooltip content="Clear">
            <button type="button" onClick={() => setLines([])} className="rounded-md p-1.5 text-white/40 hover:bg-white/[0.08] hover:text-white/80">
              <Trash2 className="size-3.5" />
            </button>
          </Tooltip>
        </div>
      }
    />
  );

  const picker = containers.length > 1 && (
    <div className="w-full sm:w-64">
      <Select
        aria-label={replicas ? "Replica" : "Container"}
        // "" reads as no choice to the select: "all" stands for every container.
        value={container ?? "all"}
        onValueChange={(v) => setContainer(v === "all" ? null : v)}
        options={[
          ...(labels && !replicas ? [] : [{ value: "all", label: replicas ? "All replicas" : "All containers" }]),
          ...containers.map((c) => ({ value: c, label: labels ? (labels[c] ?? c) : replicas ? `Replica ${c}` : c })),
        ]}
      />
    </div>
  );
  if (!requestLog && !picker) return viewer;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {requestLog ? (
          <div className="flex gap-1 rounded-xl bg-sunken p-1" role="tablist" aria-label="Logs">
            {(
              [
                ["logs", "App logs"],
                ["requests", "Requests"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={mode === id}
                onClick={() => setMode(id)}
                className={cn("h-7 rounded-lg px-3 text-[13px] font-medium transition-all", mode === id ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg")}
              >
                {label}
              </button>
            ))}
          </div>
        ) : (
          <span />
        )}
        {mode === "logs" && picker}
      </div>
      {mode === "logs" ? (
        viewer
      ) : (
        <RequestLog
          serviceId={serviceId}
          enabled={requestLog!.enabled}
          statuses={requestLog!.statuses}
          settingsHref={requestLog!.settingsHref}
          window={null}
          onClearWindow={() => {}}
        />
      )}
    </div>
  );
}
