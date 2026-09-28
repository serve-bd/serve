"use client";

import * as React from "react";
import { Pause, Play, Trash2 } from "lucide-react";
import { LogViewer, type LogLine } from "@/components/log-viewer";
import { Led } from "@/components/ui/status";
import { Tooltip } from "@/components/ui/tooltip";
import { useLatest } from "@/hooks/use-client";

type Incoming = { t: string; m: string; s: string | null; e: boolean };

export function RuntimeLogs({ serviceId, name }: { serviceId: string; name: string }) {
  const [lines, setLines] = React.useState<LogLine[]>([]);
  const [connected, setConnected] = React.useState(false);
  const [paused, setPaused] = React.useState(false);
  const pausedRef = useLatest(paused);
  const buffer = React.useRef<LogLine[]>([]);

  React.useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      es = new EventSource(`/api/services/${serviceId}/logs?tail=500`);
      es.onopen = () => setConnected(true);
      es.addEventListener("logs", (ev) => {
        const batch = JSON.parse((ev as MessageEvent).data) as Incoming[];
        buffer.current.push(...batch.map((l) => ({ text: l.m, time: l.t, source: l.s, error: l.e })));
      });
      es.addEventListener("info", (ev) => {
        const { message } = JSON.parse((ev as MessageEvent).data) as { message: string };
        buffer.current.push({ text: `— ${message}`, source: null });
      });
      es.onerror = () => {
        setConnected(false);
        es?.close();
        retry = setTimeout(connect, 3000);
      };
    };
    connect();
    // Batch UI updates for smooth scrolling under heavy output.
    const flush = setInterval(() => {
      if (pausedRef.current || !buffer.current.length) return;
      const next = buffer.current.splice(0);
      setLines((prev) => {
        const merged = prev.concat(next);
        return merged.length > 5000 ? merged.slice(-5000) : merged;
      });
    }, 250);
    return () => {
      es?.close();
      clearTimeout(retry);
      clearInterval(flush);
    };
  }, [serviceId, pausedRef]);

  return (
    <LogViewer
      lines={lines}
      showTime
      filename={`${name}.log`}
      emptyText={connected ? "No output yet." : "Connecting…"}
      height="calc(100vh - 290px)"
      toolbar={
        <div className="flex items-center gap-1">
          <span className="mr-2 flex items-center gap-2 text-[11px] text-white/50">
            <Led color={connected ? "#30d158" : "#636366"} pulse={connected && !paused} />
            {paused ? "Paused" : connected ? "Live" : "Reconnecting"}
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
}
