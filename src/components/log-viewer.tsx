"use client";

import { showError } from "@/hooks/use-action";
import { hasAnsi, parseAnsi, stripAnsi } from "@/lib/ansi";
import * as React from "react";
import { ArrowDown, Check, Clock, Copy, Download, Search, WrapText } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { copyText } from "@/components/ui/clipboard";
import { FullscreenButton } from "@/components/fullscreen-button";
import { useFullscreen } from "@/hooks/use-fullscreen";

export type LogLine = { text: string; time?: string; source?: string | null; error?: boolean };

const MAX_LINES = 5000;

/** Choices for showing only the newest lines; 0 shows all that are kept. */
const LAST_OPTIONS = [0, 100, 500, 1000, 2000];
const LAST_KEY = "serve.logs.last";
const TIMES_KEY = "serve.logs.times";

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

// A count or field that says nothing went wrong: "failed":0, "error":null, errors=0, warnings: [].
const NOTHING_WRONG = /["']?\b(errors?|fatal|panics?|exceptions?|failed|failures?|warn(ings?)?)\b["']?\s*[:=]\s*(0|null|nil|none|false|\[\]|\{\}|""|'')(?![\w.])/gi;

const ERR_LEVELS = new Set(["error", "err", "fatal", "critical", "crit", "panic", "emerg", "emergency", "alert", "severe", "failed", "failure"]);
const WARN_LEVELS = new Set(["warn", "warning"]);
const QUIET_LEVELS = new Set(["info", "debug", "trace", "notice", "verbose", "log", "http", "silly", "hint", "fine", "finer", "finest", "config"]);

function toneOfLevel(level: string) {
  const n = Number(level);
  // pino and bunyan: 10 trace … 30 info, 40 warn, 50 error, 60 fatal.
  if (level !== "" && Number.isFinite(n)) return n >= 50 ? "err" : n >= 40 ? "warn" : "";
  const l = level.toLowerCase();
  if (ERR_LEVELS.has(l)) return "err";
  if (WARN_LEVELS.has(l)) return "warn";
  if (QUIET_LEVELS.has(l)) return "";
  return null;
}

// What goes before a level word: a server prefix ([eu-1]), a BuildKit step (#12 3.40), timestamps,
// a Ruby logger's "E, [time #pid]", a time zone and process id (Postgres: UTC [42]), and a tool's name (npm).
const LEAD =
  /^\s*(?:\[[\w.-]+\]\s+)?(?:#\d+\s+(?:\d+(?:\.\d+)?\s+)?)?(?:[DIWEFA],\s+\[[^\]]*\]\s+)?(?:\[?\d{4}-\d\d-\d\d(?:[T ][\d:.,]+(?:Z|[+-]\d\d:?\d\d)?)?\]?\s+|\[?\d\d:\d\d:\d\d(?:[.,]\d+)?\]?\s+)*(?:(?:[A-Z]{3,4}\s+)?\[\d+\]\s+)?(?:npm\s+)?/;

/**
 * The level a line states about itself, when it states one: a JSON or logfmt field, or a level
 * word in front ("ERROR", "[warn]", "info:"). A lowercase word only counts in brackets or before a
 * colon, so a sentence that starts with "Error handling…" is not taken for one.
 */
function statedTone(text: string): string | null {
  const field = /["']?\b(?:level|severity|lvl|log\.level)["']?\s*[:=]\s*["']?([A-Za-z]+|\d+)/.exec(text);
  if (field) {
    const tone = toneOfLevel(field[1]);
    if (tone !== null) return tone;
  }
  // MongoDB: "s":"E" (F fatal, E error, W warning, I info, D1-D5 debug).
  const mongo = /"s"\s*:\s*"(F|E|W|I|D\d)"/.exec(text);
  if (mongo) return mongo[1] === "F" || mongo[1] === "E" ? "err" : mongo[1] === "W" ? "warn" : "";
  const rest = text.replace(LEAD, "");
  const word = /^[[(<]?([A-Za-z]+)([\])>]|!|:|\s+--|\s)?/.exec(rest);
  if (word) {
    const [, w, after] = word;
    const marked = after !== undefined && after.trim() !== "";
    if (w === w.toUpperCase() ? after !== undefined || rest.length === w.length : marked) {
      const tone = toneOfLevel(w);
      if (tone !== null) return tone;
    }
  }
  // Errors the runtimes and tools print themselves.
  if (/^\s*ERR_[A-Z_]+\b/.test(rest)) return "err";
  if (/^(?:Uncaught\s+)?[\w.$]*(?:Error|Exception)\b(?::|$)/.test(rest) || /^Exception in thread\b/.test(rest)) return "err";
  if (/^Traceback \(most recent call last\)/.test(rest)) return "err";
  return null;
}

export function lineTone(text: string) {
  if (text.startsWith("==> ")) {
    if (/failed/i.test(text)) return "step-bad";
    if (/successfully/i.test(text)) return "step-ok";
    return "step";
  }
  // A BuildKit step header names the command it starts ("#5 [2/4] RUN …"); its outcome comes on later lines.
  if (/^(?:\[[\w.-]+\]\s+)?#\d+ \[[^\]]*\d+\/\d+\] /.test(text)) return "";
  // The commit's message is someone's prose ("new error pages"), not the build reporting a problem.
  if (/^Checked out [0-9a-f]{7,} — /.test(text)) return "";
  // A level the line states (a logger's field or prefix, Serve's own "Warning:") decides it.
  const stated = statedTone(text);
  if (stated !== null) return stated;
  // No stated level: the words decide. Many apps log normally to stderr, so the stream does not.
  const said = text.replace(NOTHING_WRONG, "");
  // A word inside a path or a name (/admin/error-logs, fatal_handler) says nothing about the line.
  if (/(?<![\w/-])(error|fatal|panic|exception|failed)(?![\w/-])/i.test(said)) return "err";
  if (/(?<![\w/-])warn(ing)?(?![\w/-])/i.test(said)) return "warn";
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
  const fs = useFullscreen();
  // Timestamps take room a phone does not have: hidden there until asked for.
  const [times, setTimes] = React.useState(true);
  // The last choices are remembered in this browser, for every log.
  React.useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(LAST_KEY));
      if (LAST_OPTIONS.includes(saved)) setLast(saved);
    } catch {}
    let savedTimes: string | null = null;
    try {
      savedTimes = localStorage.getItem(TIMES_KEY);
    } catch {}
    setTimes(savedTimes ? savedTimes === "1" : window.matchMedia("(min-width: 640px)").matches);
  }, []);
  const toggleTimes = () => {
    setTimes((t) => {
      try {
        localStorage.setItem(TIMES_KEY, t ? "0" : "1");
      } catch {}
      return !t;
    });
  };
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
    <div className={cn("relative flex flex-col overflow-hidden bg-log-bg", fs.full ? "fixed inset-0 z-40" : cn("rounded-2xl border border-line shadow-sm", className))}>
      {/* Phones: the filter gets its own row, the buttons the row under it. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-3 py-2">
        <div className="relative min-w-0 basis-full sm:flex-1 sm:basis-auto">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-white/30" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter logs"
            className="h-7 w-full rounded-md sm:max-w-64 bg-white/[0.06] pr-2 pl-7 text-xs text-log-fg outline-none placeholder:text-white/30 focus:bg-white/[0.09]"
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
        {showTime && (
          <Tooltip content={times ? "Hide timestamps" : "Show timestamps"}>
            <button
              type="button"
              onClick={toggleTimes}
              aria-pressed={times}
              aria-label="Timestamps"
              className={cn("rounded-md p-1.5 text-white/40 hover:bg-white/[0.08] hover:text-white/80", times && "text-white/80")}
            >
              <Clock className="size-3.5" />
            </button>
          </Tooltip>
        )}
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
        <FullscreenButton full={fs.full} onClick={fs.toggle} />
      </div>
      <div
        ref={ref}
        onScroll={onScroll}
        className={cn("scrollbar-thin overflow-auto py-2 font-mono text-[12px] leading-[1.65] text-log-fg", fs.full && "min-h-0 flex-1")}
        style={fs.full ? undefined : { height }}
      >
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
                    {showTime && times && (
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
