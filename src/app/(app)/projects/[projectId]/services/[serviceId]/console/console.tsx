"use client";

import * as React from "react";
import useSWR from "swr";
import { Eraser, RotateCw } from "lucide-react";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { Terminal, type TerminalHandle, type TerminalStatus } from "@/components/terminal";
import { cn } from "@/lib/utils";

const STATUS: Record<TerminalStatus, { label: string; color: string }> = {
  connecting: { label: "Connecting", color: "#ffd60a" },
  connected: { label: "Connected", color: "#30d158" },
  exited: { label: "Session ended", color: "#8e8e93" },
  error: { label: "Unavailable", color: "#ff453a" },
};

/** Keys that are hard to type on a phone keyboard. */
const KEYS: { label: string; data: string }[] = [
  { label: "esc", data: "\x1b" },
  { label: "tab", data: "\t" },
  { label: "ctrl-c", data: "\x03" },
  { label: "ctrl-d", data: "\x04" },
  { label: "↑", data: "\x1b[A" },
  { label: "↓", data: "\x1b[B" },
  { label: "←", data: "\x1b[D" },
  { label: "→", data: "\x1b[C" },
];

export function Console({ serviceId, suggestions, initialTarget = null }: { serviceId: string; suggestions: string[]; initialTarget?: string | null }) {
  const { data, isLoading } = useSWR<{ targets: { name: string; composeService: string | null }[] }>(`/api/services/${serviceId}/exec`, { refreshInterval: 15000 });
  const targets = data?.targets ?? [];
  const [target, setTarget] = React.useState<string | null>(initialTarget);
  const [session, setSession] = React.useState(0);
  const [status, setStatus] = React.useState<TerminalStatus>("connecting");
  const terminal = React.useRef<TerminalHandle>(null);
  const selected = target ?? targets[0]?.composeService ?? targets[0]?.name ?? null;
  const selectedName = targets.find((t) => (t.composeService ?? t.name) === selected)?.name ?? selected;
  const ended = status === "exited" || status === "error";

  const restart = () => {
    setStatus("connecting");
    setSession((s) => s + 1);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted">An interactive shell inside the running container. Sessions close after a minute without a connected tab.</p>
        {targets.length > 1 && (
          <Select
            size="sm"
            value={selected}
            onValueChange={(v) => {
              setTarget(v);
              setStatus("connecting");
            }}
            options={targets.map((t) => ({ value: t.composeService ?? t.name, label: t.composeService ?? t.name }))}
            className="w-full sm:w-56"
          />
        )}
      </div>

      <div className="flex flex-col overflow-hidden rounded-2xl border border-line bg-log-bg shadow-sm">
        <div className="flex h-10 items-center gap-3 border-b border-white/[0.06] pr-2 pl-4 text-[11.5px] text-white/45">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn("size-1.5 flex-none rounded-full", status === "connecting" && selected && "animate-led")}
              style={{ background: selected ? STATUS[status].color : "#8e8e93" }}
            />
            <span className="truncate font-mono">{selectedName ?? "no running container"}</span>
            {selected && <span className="hidden flex-none text-white/30 sm:inline">· {STATUS[status].label}</span>}
          </span>
          <span className="ml-auto flex flex-none items-center gap-0.5">
            <Tooltip content="Clear screen">
              <button
                type="button"
                onClick={() => terminal.current?.clear()}
                disabled={!selected}
                className="rounded-md p-1.5 hover:bg-white/[0.08] hover:text-white/80 disabled:opacity-40"
                aria-label="Clear screen"
              >
                <Eraser className="size-3.5" />
              </button>
            </Tooltip>
            <Tooltip content="New session">
              <button
                type="button"
                onClick={restart}
                disabled={!selected}
                className="rounded-md p-1.5 hover:bg-white/[0.08] hover:text-white/80 disabled:opacity-40"
                aria-label="New session"
              >
                <RotateCw className="size-3.5" />
              </button>
            </Tooltip>
          </span>
        </div>

        <div className="relative">
          {selected ? (
            <Terminal
              key={`${selected}:${session}`}
              ref={terminal}
              endpoint={`/api/services/${serviceId}/terminal`}
              target={selected}
              onStatus={setStatus}
              className="h-[min(62vh,580px)] min-h-72 py-2 pl-3"
            />
          ) : (
            <div className="flex h-[min(62vh,580px)] min-h-72 flex-col items-center justify-center gap-1 px-6 text-center">
              <p className="text-[13px] font-medium text-white/80">{isLoading ? "Looking for containers…" : "No running container"}</p>
              {!isLoading && <p className="text-[12.5px] text-white/40">Deploy or start the service to open a shell.</p>}
            </div>
          )}
          {ended && selected && (
            <div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-log-bg via-log-bg/90 to-transparent pt-10 pb-5">
              <button
                type="button"
                onClick={restart}
                className="flex items-center gap-1.5 rounded-full bg-white/90 px-3.5 py-1.5 text-xs font-medium text-black shadow-lg hover:bg-white"
              >
                <RotateCw className="size-3.5" /> Start a new session
              </button>
            </div>
          )}
        </div>

        {selected && (
          <div className="scrollbar-none flex items-center gap-1.5 overflow-x-auto border-t border-white/[0.06] px-3 py-2">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                disabled={status !== "connected"}
                onClick={() => {
                  terminal.current?.send(`${s}\r`);
                  terminal.current?.focus();
                }}
                className="flex-none rounded-md bg-white/[0.06] px-2 py-1 font-mono text-[11.5px] whitespace-nowrap text-white/70 hover:bg-white/[0.1] hover:text-white disabled:opacity-40"
              >
                {s}
              </button>
            ))}
            <span className="mx-1 h-4 w-px flex-none bg-white/10 sm:hidden" />
            {KEYS.map((k) => (
              <button
                key={k.label}
                type="button"
                disabled={status !== "connected"}
                onClick={() => {
                  terminal.current?.send(k.data);
                  terminal.current?.focus();
                }}
                className="flex-none rounded-md border border-white/10 px-2 py-1 font-mono text-[11px] text-white/60 hover:bg-white/[0.08] disabled:opacity-40 sm:hidden"
              >
                {k.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
