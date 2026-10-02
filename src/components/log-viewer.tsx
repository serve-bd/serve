"use client";

import { showError } from "@/hooks/use-action";
import { hasAnsi, parseAnsi, stripAnsi } from "@/lib/ansi";
import * as React from "react";
import { ArrowDown, Check, Copy, Download, Search, WrapText } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { copyText } from "@/components/ui/clipboard";

export type LogLine = { text: string; time?: string; source?: string | null; error?: boolean };

const MAX_LINES = 5000;

/** Choices for showing only the newest lines; 0 shows all that are kept. */
const LAST_OPTIONS = [0, 100, 500, 1000, 2000];
const LAST_KEY = "serve.logs.last";

const lineText = (l: LogLine) => (l.time ? `${l.time} ` : "") + stripAnsi(l.text);

/** Copies text, saying so when the browser refuses. Returns whether it worked. */
async function copy(text: string) {
  if (await copyText(text)) return true;
  showError("Could not copy. Select the text and copy it by hand.");
  return false;
}

/** Copy button of one line, shown when the line is hovered. */
function LineCopy({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        if (!(await copy(text))) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className={cn(
        "absolute top-0 right-2 rounded bg-log-bg/90 p-1 text-white/40 opacity-0 transition-opacity group-hover:opacity-100 hover:text-white/90 focus-visible:opacity-100",
        copied && "opacity-100",
      )}
      aria-label="Copy line"
    >
      {copied ? <Check className="size-3 text-[#30d158]" /> : <Copy className="size-3" />}
    </button>
  );
}

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

/** Terminal-style log viewer with follow mode, search, newest-lines limit, copy, wrap and download. */
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
  const [last, setLast] = React.useState(0);
  const [copied, setCopied] = React.useState(false);
  // The last choice is remembered in this browser, for every log.
  React.useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(LAST_KEY));
      if (LAST_OPTIONS.includes(saved)) setLast(saved);
    } catch {}
  }, []);
  const chooseLast = (n: number) => {
    setLast(n);
    try {
      localStorage.setItem(LAST_KEY, String(n));
    } catch {}
  };

  const visible = React.useMemo(() => {
    const src = lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines;
    // Numbered within the whole log, so a line keeps its number (and key) once older ones are cut.
    const numbered = src.map((l, i) => ({ ...l, n: lines.length - src.length + i + 1 }));
    const q = query.toLowerCase();
    const matching = q ? numbered.filter((l) => stripAnsi(l.text).toLowerCase().includes(q)) : numbered;
    return last ? matching.slice(-last) : matching;
  }, [lines, query, last]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll again whenever the visible lines change.
  React.useLayoutEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [visible, follow]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom !== follow) setFollow(atBottom);
  };

  const copyVisible = async () => {
    if (!(await copy(visible.map(lineText).join("\n")))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const download = () => {
    const blob = new Blob([lines.map(lineText).join("\n")], { type: "text/plain" });
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
        <Tooltip content="Show only the newest lines">
          <select
            value={last}
            onChange={(e) => chooseLast(Number(e.target.value))}
            aria-label="Lines shown"
            className="h-7 rounded-md bg-white/[0.06] px-1.5 text-[11px] text-white/70 outline-none hover:bg-white/[0.09] focus:bg-white/[0.09]"
          >
            {LAST_OPTIONS.map((n) => (
              <option key={n} value={n} className="bg-[#1c1c1e] text-white">
                {n ? `Last ${n}` : "All lines"}
              </option>
            ))}
          </select>
        </Tooltip>
        <Tooltip content={copied ? "Copied" : query || last ? `Copy the ${visible.length} lines shown` : "Copy all lines"}>
          <button
            type="button"
            onClick={copyVisible}
            disabled={!visible.length}
            className="rounded-md p-1.5 text-white/40 hover:bg-white/[0.08] hover:text-white/80 disabled:opacity-40"
            aria-label="Copy lines"
          >
            {copied ? <Check className="size-3.5 text-[#30d158]" /> : <Copy className="size-3.5" />}
          </button>
        </Tooltip>
        <Tooltip content={wrap ? "Disable wrapping" : "Wrap lines"}>
          <button
            type="button"
            onClick={() => setWrap((w) => !w)}
            className={cn("rounded-md p-1.5 text-white/40 hover:bg-white/[0.08] hover:text-white/80", wrap && "text-white/80")}
          >
            <WrapText className="size-3.5" />
          </button>
        </Tooltip>
        <Tooltip content="Download">
          <button type="button" onClick={download} className="rounded-md p-1.5 text-white/40 hover:bg-white/[0.08] hover:text-white/80">
            <Download className="size-3.5" />
          </button>
        </Tooltip>
      </div>
      <div ref={ref} onScroll={onScroll} className="scrollbar-thin overflow-auto py-2 font-mono text-[12px] leading-[1.65] text-log-fg" style={{ height }}>
        {visible.length === 0 ? (
          <div className="px-4 py-3 text-white/35">{query ? "No lines match the filter." : emptyText}</div>
        ) : (
          <table className="w-full border-collapse">
            <tbody>
              {visible.map((l) => {
                const colored = hasAnsi(l.text);
                const tone = lineTone(colored ? stripAnsi(l.text) : l.text);
                return (
                  <tr key={l.n} className={cn("group align-top hover:bg-white/[0.03]", tone.startsWith("step") && "bg-white/[0.035]")}>
                    <td className="w-px pr-3 pl-4 text-right whitespace-nowrap text-white/20 select-none tabular-nums">{l.n}</td>
                    {showTime && (
                      <td className="w-px pr-3 whitespace-nowrap text-white/30 select-none tabular-nums">
                        {l.time ? new Date(l.time).toLocaleTimeString([], { hour12: false }) : ""}
                      </td>
                    )}
                    {l.source !== undefined && l.source !== null && <td className="w-px pr-3 whitespace-nowrap text-[#64d2ff]/70 select-none">{l.source}</td>}
                    <td
                      className={cn(
                        "relative pr-4",
                        wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre",
                        tone === "step" && "font-semibold text-white",
                        tone === "step-ok" && "font-semibold text-[#30d158]",
                        tone === "step-bad" && "font-semibold text-[#ff453a]",
                        tone === "err" && "text-[#ff6961]",
                        tone === "warn" && "text-[#ffd60a]/90",
                      )}
                    >
                      {colored
                        ? parseAnsi(l.text).map((part, pi) => (
                            <span key={pi} style={{ color: part.color }} className={cn(part.bold && "font-semibold", part.dim && "opacity-60")}>
                              {part.text}
                            </span>
                          ))
                        : l.text.startsWith("==> ")
                          ? l.text.slice(4)
                          : l.text || " "}
                      {l.text && <LineCopy text={stripAnsi(l.text)} />}
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
