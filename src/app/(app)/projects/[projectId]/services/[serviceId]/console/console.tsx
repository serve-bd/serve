"use client";

import * as React from "react";
import useSWR from "swr";
import { CornerDownLeft, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Entry = { id: number; command: string; output: string; exitCode: number | null; target: string | null };

export function Console({ serviceId, suggestions }: { serviceId: string; suggestions: string[] }) {
  const { data } = useSWR<{ targets: { name: string; composeService: string | null }[] }>(`/api/services/${serviceId}/exec`, { refreshInterval: 15000 });
  const targets = data?.targets ?? [];
  const [target, setTarget] = React.useState<string | null>(null);
  const [command, setCommand] = React.useState("");
  const [entries, setEntries] = React.useState<Entry[]>([]);
  const [running, setRunning] = React.useState(false);
  const [history, setHistory] = React.useState<string[]>([]);
  const [cursor, setCursor] = React.useState(-1);
  const abort = React.useRef<AbortController | null>(null);
  const scroller = React.useRef<HTMLDivElement>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const selected = target ?? targets[0]?.composeService ?? targets[0]?.name ?? null;

  React.useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [entries]);

  async function runCommand(cmd: string) {
    if (!cmd.trim() || running) return;
    const id = Date.now();
    setEntries((e) => [...e, { id, command: cmd, output: "", exitCode: null, target: selected }]);
    setHistory((h) => [cmd, ...h.filter((x) => x !== cmd)].slice(0, 50));
    setCursor(-1);
    setCommand("");
    setRunning(true);
    const controller = new AbortController();
    abort.current = controller;
    const update = (patch: Partial<Entry>) => setEntries((all) => all.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    try {
      const res = await fetch(`/api/services/${serviceId}/exec`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: cmd, target: selected }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: `Request failed (${res.status})` }));
        update({ output: err.error, exitCode: 1 });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        const marker = text.lastIndexOf("\u0000");
        if (marker !== -1) update({ output: text.slice(0, marker).replace(/\n$/, ""), exitCode: Number(text.slice(marker + 1)) || 0 });
        else update({ output: text });
      }
    } catch {
      update({ exitCode: 130 });
    } finally {
      setRunning(false);
      abort.current = null;
      input.current?.focus();
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted">Run one-off commands inside a running container, like migrations or maintenance scripts.</p>
        {targets.length > 1 && (
          <Select size="sm" value={selected} onValueChange={setTarget} options={targets.map((t) => ({ value: t.composeService ?? t.name, label: t.composeService ?? t.name }))} className="w-56" />
        )}
      </div>
      <div className="flex flex-col overflow-hidden rounded-2xl border border-line bg-log-bg shadow-sm">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2 text-[11px] text-white/40">
          <span className="font-mono">{selected ?? "no running container"}</span>
          <button type="button" onClick={() => setEntries([])} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/[0.08] hover:text-white/80">
            <Trash2 className="size-3" /> Clear
          </button>
        </div>
        <div ref={scroller} className="scrollbar-thin h-[min(60vh,560px)] overflow-y-auto px-4 py-3 font-mono text-[12.5px] leading-[1.65] text-log-fg">
          {entries.length === 0 && (
            <div className="flex flex-col gap-2 text-white/40">
              <span>Try one of these:</span>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((s) => (
                  <button key={s} type="button" onClick={() => setCommand(s)} className="rounded-md bg-white/[0.06] px-2 py-1 text-left text-white/70 hover:bg-white/[0.1]">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {entries.map((e) => (
            <div key={e.id} className="mb-3">
              <div className="flex items-center gap-2 text-white">
                <span className="text-[#0a84ff]">$</span>
                <span className="break-all">{e.command}</span>
                {e.exitCode !== null && (
                  <span className={cn("ml-auto shrink-0 rounded px-1.5 text-[10px] font-semibold", e.exitCode === 0 ? "bg-[#30d158]/15 text-[#30d158]" : "bg-[#ff453a]/15 text-[#ff453a]")}>
                    exit {e.exitCode}
                  </span>
                )}
              </div>
              {e.output && <pre className="mt-1 break-all whitespace-pre-wrap text-log-fg/90">{e.output}</pre>}
              {e.exitCode === null && <span className="mt-1 inline-block h-3.5 w-2 animate-led bg-white/60" />}
            </div>
          ))}
        </div>
        <form
          className="flex items-center gap-2 border-t border-white/[0.06] px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            void runCommand(command);
          }}
        >
          <span className="pl-1 font-mono text-[13px] text-[#0a84ff]">$</span>
          <input
            ref={input}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" && history.length) {
                e.preventDefault();
                const next = Math.min(cursor + 1, history.length - 1);
                setCursor(next);
                setCommand(history[next]);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                const next = cursor - 1;
                setCursor(Math.max(-1, next));
                setCommand(next >= 0 ? history[next] : "");
              }
            }}
            disabled={!targets.length}
            placeholder={targets.length ? "Type a command and press Enter" : "Start the service to use the console"}
            className="h-8 flex-1 bg-transparent font-mono text-[13px] text-white outline-none placeholder:text-white/30"
            autoComplete="off"
            spellCheck={false}
          />
          {running ? (
            <Button size="xs" variant="danger" onClick={() => abort.current?.abort()}>
              <Square /> Stop
            </Button>
          ) : (
            <Button size="xs" variant="primary" type="submit" disabled={!command.trim() || !targets.length}>
              <CornerDownLeft /> Run
            </Button>
          )}
        </form>
      </div>
    </div>
  );
}
