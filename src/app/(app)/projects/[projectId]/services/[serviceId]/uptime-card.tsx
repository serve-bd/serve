"use client";

import Link from "next/link";
import { useCan } from "@/components/permissions";
import { duration } from "@/lib/duration";
import { Activity, ChevronRight, CircleAlert, CircleCheck } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardHeader, TimeAgo } from "@/components/ui/misc";
import { AreaChart } from "@/components/charts/area-chart";
import { formatUptime, UptimeBars } from "@/components/uptime-bars";
import { cn } from "@/lib/utils";
import type { MonitorSummary } from "@/server/monitoring/queries";

const statusText = { up: "Up", down: "Down", pending: "Checking…", paused: "Paused" } as const;

/** Uptime of a service on its Overview: status, 90-day bars, response time and incidents. */
export function UptimeCard({ summary, settingsHref }: { summary: MonitorSummary; settingsHref: string }) {
  const m = summary.monitor;
  // Monitoring settings need "manage services"; others only see the numbers.
  const canManage = useCan()("services.manage");
  if (!m) {
    // Small card for the side column: an invitation, not a big empty panel.
    return (
      <Card className="h-fit">
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 flex-none items-center justify-center rounded-lg bg-fg/[0.05] text-muted [&_svg]:size-4">
              <Activity />
            </span>
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-fg">Uptime</p>
              <p className="text-xs text-muted">Not monitored</p>
            </div>
          </div>
          <p className="text-[13px] leading-5 text-fg-2">
            {canManage ? "Get an alert when this service goes down, and when it comes back." : "No uptime check is set up for this service."}
          </p>
          {canManage && (
            <Link href={settingsHref} className={cn(buttonVariants({ size: "sm", variant: "secondary" }), "w-full")}>
              Set up monitoring
            </Link>
          )}
        </div>
      </Card>
    );
  }
  const down = m.status === "down";
  return (
    <Card>
      <CardHeader
        title="Uptime"
        description={
          m.kind === "http"
            ? `HTTP check every ${m.intervalSeconds < 60 ? `${m.intervalSeconds} s` : `${m.intervalSeconds / 60} min`}`
            : `Container check every ${m.intervalSeconds < 60 ? `${m.intervalSeconds} s` : `${m.intervalSeconds / 60} min`}`
        }
        actions={
          canManage && (
            <Link href={settingsHref} className={buttonVariants({ size: "sm", variant: "ghost" })}>
              Monitoring <ChevronRight />
            </Link>
          )
        }
      />
      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className={cn("inline-flex items-center gap-2 text-[15px] font-semibold", down ? "text-bad" : m.status === "up" ? "text-ok" : "text-muted")}>
            {down ? <CircleAlert className="size-4" /> : <CircleCheck className="size-4" />}
            {m.enabled ? statusText[m.status] : "Paused"}
          </span>
          <Figure label="24 hours" value={formatUptime(summary.uptime.day)} />
          <Figure label="30 days" value={formatUptime(summary.uptime.month)} />
          <Figure label="90 days" value={formatUptime(summary.uptime.quarter)} />
          <Figure label="Response" value={m.lastLatencyMs !== null ? `${m.lastLatencyMs} ms` : "—"} />
        </div>
        <div className="flex flex-col gap-1.5">
          <UptimeBars bars={summary.bars} />
          <div className="flex justify-between text-[11px] text-faint">
            <span>90 days ago</span>
            <span>Today</span>
          </div>
        </div>
        {summary.latency.some((p) => p.v !== null) && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">Response time, last 24 hours</span>
            <AreaChart data={summary.latency} color="var(--accent)" format={(v) => `${Math.round(v)} ms`} height={48} />
          </div>
        )}
        {m.lastError && m.status !== "up" && <p className="rounded-xl border border-bad/20 bg-bad-soft px-3 py-2 text-[13px] text-fg-2">{m.lastError}</p>}
        {m.lastCheckedAt && (
          <p className="text-xs text-faint">
            Last checked <TimeAgo date={m.lastCheckedAt} />
          </p>
        )}
      </div>
      {summary.incidents.length > 0 && (
        <div className="divide-y divide-line border-t border-line">
          {summary.incidents.map((i) => (
            <div key={i.id} className="flex items-start gap-3 px-5 py-2.5 text-[13px]">
              <span className={cn("mt-1.5 size-1.5 flex-none rounded-full", i.resolvedAt ? "bg-idle" : i.severity === "warning" ? "bg-warn" : "bg-bad")} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-fg-2">{i.title}</p>
                <p className="text-xs text-muted">
                  <TimeAgo date={i.startedAt} />
                  {i.resolvedAt ? ` · resolved after ${duration(i.startedAt, i.resolvedAt)}` : " · ongoing"}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col">
      <span className="text-[11px] text-faint">{label}</span>
      <span className="text-[14px] font-medium text-fg tabular-nums">{value}</span>
    </span>
  );
}
