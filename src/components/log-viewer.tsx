"use client";

import * as React from "react";
import { ArrowDown, Download, Search, WrapText } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";

export type LogLine = { text: string; time?: string; source?: string | null; error?: boolean };

const MAX_LINES = 5000;

function lineTone(text: string) {
  if (text.startsWith("==> ")) {
    if (/failed/i.test(text)) return "step-bad";
    if (/successfully/i.test(text)) return "step-ok";
    return "step";
  }
  // Many apps log normally to stderr, so only the content decides the tone.
  if (/\b(error|fatal|panic|exception|failed)\b/i.test(text)) return "err";
  if (/\bwarn(ing)?\b/i.test(text)) return "warn";
  return "";
}

/** Terminal-style log viewer with follow mode, search, wrap and download. */
export function LogViewer({
  lines,
  className,
  height = "min(70vh, 640px)",
  emptyText = "Waiting for output…",
  toolbar,
  showTime = false,
  filename = "logs.txt",
}: {
  lines: LogLine[];
  className?: string;
  height?: string;
  emptyText?: string;
  toolbar?: React.ReactNode;
  showTime?: boolean;
  filename?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [follow, setFollow] = React.useState(true);
  const [wrap, setWrap] = React.useState(true);
  const [query, setQuery] = React.useState("");

  const visible = React.useMemo(() => {
    const src = lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines;
    if (!query) return src.map((l, i) => ({ ...l, n: i + 1 }));
    const q = query.toLowerCase();
    return src.map((l, i) => ({ ...l, n: i + 1 })).filter((l) => l.text.toLowerCase().includes(q));
  }, [lines, query]);

  React.useLayoutEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [visible, follow]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom !== follow) setFollow(atBottom);
  };

  const download = () => {
    const blob = new Blob([lines.map((l) => (l.time ? `${l.time} ` : "") + l.text).join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={cn("relative flex flex-col overflow-hidden rounded-2xl border border-line bg-log-bg shadow-sm", className)}>
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-white/30" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter logs"
            className="h-7 w-full max-w-64 rounded-md bg-white/[0.06] pr-2 pl-7 text-xs text-log-fg outline-none placeholder:text-white/30 focus:bg-white/[0.09]"
          />
        </div>
        {toolbar}
        <Tooltip content={wrap ? "Disable wrapping" : "Wrap lines"}>
          <button type="button" onClick={() => setWrap((w) => !w)} className={cn("rounded-md p-1.5 text-white/40 hover:bg-white/[0.08] hover:text-white/80", wrap && "text-white/80")}>
            <WrapText className="size-3.5" />
          </button>
        </Tooltip>
        <Tooltip content="Download">
          <button type="button" onClick={download} className="rounded-md p-1.5 text-white/40 hover:bg-white/[0.08] hover:text-white/80">
            <Download className="size-3.5" />
          </button>
        </Tooltip>
      </div>
      <div
        ref={ref}
        onScroll={onScroll}
        className="scrollbar-thin overflow-auto py-2 font-mono text-[12px] leading-[1.65] text-log-fg"
        style={{ height }}
      >
        {visible.length === 0 ? (
          <div className="px-4 py-3 text-white/35">{query ? "No lines match the filter." : emptyText}</div>
        ) : (
          <table className="w-full border-collapse">
            <tbody>
              {visible.map((l) => {
                const tone = lineTone(l.text);
                return (
                  <tr key={l.n} className={cn("group align-top hover:bg-white/[0.03]", tone.startsWith("step") && "bg-white/[0.035]")}>
                    <td className="w-px pr-3 pl-4 text-right whitespace-nowrap text-white/20 select-none tabular-nums">{l.n}</td>
                    {showTime && (
                      <td className="w-px pr-3 whitespace-nowrap text-white/30 select-none tabular-nums">
                        {l.time ? new Date(l.time).toLocaleTimeString([], { hour12: false }) : ""}
                      </td>
                    )}
                    {l.source !== undefined && l.source !== null && (
                      <td className="w-px pr-3 whitespace-nowrap text-[#64d2ff]/70 select-none">{l.source}</td>
                    )}
                    <td
                      className={cn(
                        "pr-4",
                        wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre",
                        tone === "step" && "font-semibold text-white",
                        tone === "step-ok" && "font-semibold text-[#30d158]",
                        tone === "step-bad" && "font-semibold text-[#ff453a]",
                        tone === "err" && "text-[#ff6961]",
                        tone === "warn" && "text-[#ffd60a]/90",
                      )}
                    >
                      {l.text.startsWith("==> ") ? l.text.slice(4) : l.text || " "}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {!follow && (
        <button
          type="button"
          onClick={() => {
            setFollow(true);
            if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
          }}
          className="absolute right-4 bottom-4 flex items-center gap-1.5 rounded-full bg-white/90 px-3 py-1.5 text-xs font-medium text-black shadow-lg backdrop-blur hover:bg-white"
        >
          <ArrowDown className="size-3.5" /> Follow
        </button>
      )}
    </div>
  );
}
