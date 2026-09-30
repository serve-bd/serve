"use client";

import * as React from "react";
import Link from "next/link";
import useSWR from "swr";
import { ChevronRight, CircleCheck, CircleX, Loader2, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type Live = {
  id: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  serviceId: string;
  serviceName: string;
  projectId: string;
  projectName: string;
};

const ACTIVE = new Set(["queued", "building", "deploying"]);
const label: Record<string, string> = { queued: "Queued", building: "Building", deploying: "Deploying", success: "Deployed", failed: "Failed", cancelled: "Cancelled" };

function elapsed(from: string, now: number) {
  const s = Math.max(0, Math.round((now - new Date(from).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/**
 * Floating pill on every page while deployments run: how many, and a list that jumps to each
 * one's log. Finished deployments stay a few seconds with their result, then it hides.
 */
export function DeploymentsIndicator() {
  const [dismissed, setDismissed] = React.useState<Set<string>>(new Set());
  const { data } = useSWR<{ deployments: Live[] }>("/api/deployments/active", {
    // Deployments starting and finishing arrive as live events; this is only a fallback.
    refreshInterval: 30_000,
  });
  const [now, setNow] = React.useState(() => Date.now());
  const list = (data?.deployments ?? []).filter((d) => !dismissed.has(d.id));
  const running = list.filter((d) => ACTIVE.has(d.status));
  const done = list.filter((d) => !ACTIVE.has(d.status));

  React.useEffect(() => {
    if (!running.length) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running.length]);

  // Toasts share the corner: lift them above the pill while it shows.
  const visible = list.length > 0;
  React.useEffect(() => {
    document.documentElement.style.setProperty("--deploy-pill", visible ? "52px" : "0px");
    return () => document.documentElement.style.setProperty("--deploy-pill", "0px");
  }, [visible]);

  if (!list.length) return null;
  const failed = done.some((d) => d.status === "failed");
  const title = running.length
    ? running.length === 1
      ? `${label[running[0].status]} ${running[0].serviceName}`
      : `${running.length} deployments running`
    : done.length === 1
      ? `${done[0].serviceName} ${done[0].status === "success" ? "deployed" : done[0].status === "failed" ? "failed" : "cancelled"}`
      : `${done.length} deployments finished`;

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-40 flex max-w-[calc(100vw-2rem)] justify-end">
      <Popover>
        <PopoverTrigger
          className={cn(
            "pointer-events-auto flex max-w-full items-center gap-2 rounded-full border bg-surface/95 py-2 pr-3 pl-3.5 text-[13px] font-medium text-fg shadow-lg backdrop-blur-xl transition-colors hover:bg-surface",
            running.length ? "border-accent/40" : failed ? "border-bad/40" : "border-ok/40",
          )}
          aria-live="polite"
        >
          {running.length ? (
            <Loader2 className="size-4 flex-none animate-spin text-accent" />
          ) : failed ? (
            <CircleX className="size-4 flex-none text-bad" />
          ) : (
            <CircleCheck className="size-4 flex-none text-ok" />
          )}
          <span className="truncate">{title}</span>
          {running.length === 1 && <span className="flex-none text-xs font-normal text-muted tabular-nums">{elapsed(running[0].startedAt ?? running[0].createdAt, now)}</span>}
          <ChevronRight className="size-3.5 flex-none -rotate-90 text-faint" />
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="w-[min(22rem,calc(100vw-2rem))] p-1">
          <div className="flex items-center justify-between px-2.5 pt-1.5 pb-1">
            <span className="text-[11px] font-medium tracking-wide text-faint uppercase">Deployments</span>
            {done.length > 0 && (
              <button
                type="button"
                onClick={() => setDismissed((s) => new Set([...s, ...done.map((d) => d.id)]))}
                className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-fg"
              >
                <X className="size-3" /> Clear finished
              </button>
            )}
          </div>
          <ul className="max-h-80 overflow-y-auto">
            {list.map((d) => {
              const active = ACTIVE.has(d.status);
              return (
                <li key={d.id}>
                  <Link
                    href={`/projects/${d.projectId}/services/${d.serviceId}/deployments/${d.id}`}
                    className="flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-hover"
                  >
                    {active ? (
                      <Loader2 className="size-4 flex-none animate-spin text-accent" />
                    ) : d.status === "success" ? (
                      <CircleCheck className="size-4 flex-none text-ok" />
                    ) : (
                      <CircleX className="size-4 flex-none text-bad" />
                    )}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13px] font-medium text-fg">{d.serviceName}</span>
                      <span className="truncate text-xs text-muted">{d.projectName}</span>
                    </span>
                    <span className="flex flex-none flex-col items-end">
                      <span className={cn("text-xs", active ? "text-accent" : d.status === "success" ? "text-ok" : "text-bad")}>{label[d.status] ?? d.status}</span>
                      {active && <span className="text-[11px] text-faint tabular-nums">{elapsed(d.startedAt ?? d.createdAt, now)}</span>}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}
