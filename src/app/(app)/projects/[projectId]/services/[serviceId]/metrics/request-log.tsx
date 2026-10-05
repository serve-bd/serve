"use client";

import Link from "next/link";
import { ChevronDown, ChevronRight, Search, X } from "lucide-react";
import * as React from "react";
import useSWRInfinite from "swr/infinite";
import { REQUESTS_EVENT } from "@/components/shell/live-updates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, Card } from "@/components/ui/misc";
import { cn, formatBytes } from "@/lib/utils";

type Row = {
  id: number;
  time: string;
  hostname: string;
  method: string | null;
  path: string;
  query: boolean;
  status: number;
  durationMs: number;
  bytes: number;
  ip: string | null;
  userAgent: string | null;
  referer: string | null;
  answeredBy: string | null;
};
type Page = { requests: Row[]; next: string | null };

const groups = [2, 3, 4, 5] as const;
const tone = (status: number) => (status >= 500 ? "bad" : status >= 400 ? "warn" : status >= 300 ? "info" : "ok");

/** A time window picked on the traffic chart: only requests in it. */
export type Window = { from: number; to: number } | null;

/** Single requests through the proxy, newest first, with filters (the service's request log). */
export function RequestLog({
  serviceId,
  enabled,
  statuses,
  settingsHref,
  window,
  onClearWindow,
}: {
  serviceId: string;
  enabled: boolean;
  /** Status groups the log keeps (others are never there to show). */
  statuses: number[];
  settingsHref: string;
  window: Window;
  onClearWindow: () => void;
}) {
  const [shown, setShown] = React.useState<number[]>([]);
  const [path, setPath] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState<number | null>(null);
  // Typing filters after a short pause, not on every key.
  React.useEffect(() => {
    const t = setTimeout(() => setSearch(path.trim()), 300);
    return () => clearTimeout(t);
  }, [path]);

  const query = new URLSearchParams();
  if (shown.length) query.set("status", shown.join(","));
  if (search) query.set("path", search);
  if (window) {
    query.set("from", new Date(window.from).toISOString());
    query.set("to", new Date(window.to).toISOString());
  }
  const base = `/api/services/${serviceId}/request-log?${query}`;
  const { data, size, setSize, mutate, isLoading, isValidating } = useSWRInfinite<Page>(
    (i, prev: Page | null) => (!enabled ? null : i === 0 ? base : prev?.next ? `${base}&before=${encodeURIComponent(prev.next)}` : null),
    { revalidateFirstPage: true },
  );
  // New requests arrive live: the worker announces them after each read of the proxy's log.
  React.useEffect(() => {
    const onNew = (e: Event) => {
      if ((e as CustomEvent<string | null>).detail === serviceId) void mutate();
    };
    globalThis.addEventListener(REQUESTS_EVENT, onNew);
    return () => globalThis.removeEventListener(REQUESTS_EVENT, onNew);
  }, [serviceId, mutate]);

  // And at once: while the newest requests are shown, the proxy's log is followed and each request
  // comes in as it happens. They stay until the saved copies replace them.
  const [live, setLive] = React.useState<Row[]>([]);
  const [streaming, setStreaming] = React.useState(false);
  const following = enabled && !window;
  React.useEffect(() => {
    if (!following) return;
    const es = new EventSource(`/api/services/${serviceId}/request-log/stream`);
    es.addEventListener("ready", () => setStreaming(true));
    es.addEventListener("requests", (e) => {
      const batch = JSON.parse((e as MessageEvent<string>).data) as Row[];
      setLive((l) => [...batch.reverse(), ...l].slice(0, 500));
    });
    es.addEventListener("problem", () => es.close());
    es.onerror = () => setStreaming(false);
    return () => {
      es.close();
      setStreaming(false);
      setLive([]);
    };
  }, [following, serviceId]);

  if (!enabled)
    return (
      <Card className="flex flex-col gap-1 p-5">
        <span className="text-[13px] font-medium text-fg">Request log</span>
        <p className="text-[13px] text-muted">
          Only counts are kept. To see each request (path, status, response time and which server answered),{" "}
          <Link href={settingsHref} className="text-accent hover:underline">
            turn on the request log
          </Link>
          .
        </p>
      </Card>
    );

  const saved = data?.flatMap((p) => p.requests) ?? [];
  // Live rows newer than the newest saved one, through the same filters as the list.
  const newest = saved[0]?.time ?? "";
  const pathFilter = search.toLowerCase();
  const fresh = live.filter(
    (r) =>
      r.time > newest && (!shown.length || shown.includes(Math.floor(r.status / 100) as (typeof groups)[number])) && (!pathFilter || r.path.toLowerCase().includes(pathFilter)),
  );
  const rows = [...fresh, ...saved];
  const more = !!data?.at(-1)?.next;
  const filtered = shown.length > 0 || !!search || !!window;

  return (
    <Card className="flex flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
        <span className="mr-auto flex items-center gap-2 text-[13px] font-medium text-fg">
          Request log
          {streaming && (
            <span className="flex items-center gap-1.5 text-[11px] font-normal text-muted" title="New requests show as they happen.">
              <span className="size-1.5 rounded-full bg-ok" /> Live
            </span>
          )}
        </span>
        {window && (
          <Badge tone="accent" className="h-6 pr-1">
            {new Date(window.from).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} –{" "}
            {new Date(window.to).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            <button type="button" aria-label="Show every time" onClick={onClearWindow} className="rounded-full p-0.5 hover:bg-fg/10">
              <X />
            </button>
          </Badge>
        )}
        <div className="flex gap-1 rounded-xl bg-sunken p-1">
          {groups.map((g) => {
            const on = shown.includes(g);
            const kept = statuses.includes(g);
            return (
              <button
                key={g}
                type="button"
                aria-pressed={on}
                title={kept ? undefined : `${g}xx responses are not kept (Settings → Monitoring).`}
                onClick={() => setShown((s) => (on ? s.filter((x) => x !== g) : [...s, g]))}
                className={cn("h-7 rounded-lg px-2.5 font-mono text-xs transition-all", on ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg", !kept && "opacity-50")}
              >
                {g}xx
              </button>
            );
          })}
        </div>
        <div className="relative w-full sm:w-56">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
          <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="Filter by path" className="h-8 pl-8 font-mono text-[12px]" aria-label="Filter by path" />
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-[13px] text-muted">
          {isLoading ? "Loading…" : filtered ? "No requests match these filters." : `No requests kept yet. New ${statuses.map((s) => `${s}xx`).join(", ")} responses show here.`}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[12.5px]">
            <thead>
              <tr className="text-left text-[11px] font-medium text-faint uppercase">
                <th className="w-6 py-2 pl-5" />
                <th className="py-2 pr-3 font-medium">Time</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Request</th>
                <th className="py-2 pr-3 text-right font-medium">Time taken</th>
                <th className="py-2 pr-5 font-medium">Answered by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <React.Fragment key={r.id}>
                  <tr
                    onClick={() => setOpen((o) => (o === r.id ? null : r.id))}
                    className={cn("cursor-pointer border-t border-line hover:bg-hover", open === r.id && "bg-hover")}
                    aria-expanded={open === r.id}
                  >
                    <td className="py-2 pl-5 text-faint">{open === r.id ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</td>
                    <td className="py-2 pr-3 whitespace-nowrap text-muted tabular-nums" title={new Date(r.time).toLocaleString()}>
                      {new Date(r.time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge tone={tone(r.status)} className="font-mono">
                        {r.status}
                      </Badge>
                    </td>
                    <td className="max-w-[28rem] truncate py-2 pr-3 font-mono" title={r.path}>
                      <span className="text-muted">{r.method ?? ""}</span> {r.path}
                      {r.query && <span className="text-faint">?…</span>}
                    </td>
                    <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums">{r.durationMs} ms</td>
                    <td className="py-2 pr-5 whitespace-nowrap text-muted">{r.answeredBy ?? "—"}</td>
                  </tr>
                  {open === r.id && (
                    <tr className="bg-hover">
                      <td />
                      <td colSpan={5} className="pr-5 pb-3">
                        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[12px]">
                          <dt className="text-faint">Time</dt>
                          <dd className="tabular-nums">{new Date(r.time).toLocaleString()}</dd>
                          <dt className="text-faint">Domain</dt>
                          <dd className="font-mono">{r.hostname}</dd>
                          <dt className="text-faint">Sent</dt>
                          <dd>{formatBytes(r.bytes)}</dd>
                          {r.query && (
                            <>
                              <dt className="text-faint">Query</dt>
                              <dd className="text-muted">Not kept: query strings can hold tokens.</dd>
                            </>
                          )}
                          <dt className="text-faint">Visitor IP</dt>
                          <dd className="font-mono">{r.ip ?? "Not kept"}</dd>
                          <dt className="text-faint">User agent</dt>
                          <dd className="break-all">{r.userAgent ?? "—"}</dd>
                          <dt className="text-faint">Referer</dt>
                          <dd className="break-all">{r.referer ?? "—"}</dd>
                        </dl>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {more && (
        <div className="flex justify-center border-t border-line p-3">
          <Button type="button" size="sm" variant="ghost" loading={isValidating && size > (data?.length ?? 0)} onClick={() => setSize(size + 1)}>
            Show older requests
          </Button>
        </div>
      )}
    </Card>
  );
}
