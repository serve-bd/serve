"use client";

import Link from "next/link";
import { QuietDot } from "@/components/ui/status";
import { useNow } from "@/hooks/use-client";
import { formatDuration } from "@/lib/utils";

export type DeploymentTableRow = {
  id: string;
  status: string;
  commitMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  serviceId: string;
  serviceName: string;
  projectId: string;
  projectName: string;
  environmentName: string | null;
  serverName: string | null;
};

function dayLabel(date: Date, now: Date) {
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(now) - start(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

/**
 * Recent deployments on a rail, grouped by day in the viewer's timezone. Each stop is a status
 * light; the rail makes the order of what shipped readable at a glance.
 */
export function DeployTimeline({ rows }: { rows: DeploymentTableRow[] }) {
  // Grouped after mounting: the server does not know the viewer's timezone.
  const nowMs = useNow();
  const now = nowMs === null ? null : new Date(nowMs);
  const groups: { label: string; rows: DeploymentTableRow[] }[] = [];
  for (const d of rows) {
    const label = now ? dayLabel(new Date(d.createdAt), now) : "Recent";
    const last = groups.at(-1);
    if (last?.label === label) last.rows.push(d);
    else groups.push({ label, rows: [d] });
  }
  return (
    <div className="flex flex-col gap-5">
      {groups.map((g) => (
        <section key={g.label} className="flex flex-col">
          <h3 className="mb-1 text-[11px] font-medium tracking-wide text-faint uppercase">{g.label}</h3>
          <ol>
            {g.rows.map((d, i) => {
              const duration = d.startedAt && d.finishedAt ? formatDuration(new Date(d.finishedAt).getTime() - new Date(d.startedAt).getTime()) : null;
              return (
                <li key={d.id} className="relative">
                  {/* The rail: from this light to the next one, none after the last. */}
                  {i < g.rows.length - 1 && <span aria-hidden className="absolute top-[25px] -bottom-[11px] left-[3.75rem] w-px bg-line" />}
                  <Link
                    href={`/projects/${d.projectId}/services/${d.serviceId}/deployments/${d.id}`}
                    className="group -mx-2 grid grid-cols-[2.5rem_1rem_minmax(0,1fr)] items-start gap-x-3 rounded-lg px-2 py-2 transition-colors hover:bg-hover/60 sm:grid-cols-[2.5rem_1rem_minmax(0,1fr)_auto]"
                  >
                    <time className="text-left font-mono text-[12px] leading-5 text-faint tabular-nums" dateTime={new Date(d.createdAt).toISOString()}>
                      {now ? new Date(d.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : ""}
                    </time>
                    <span className="flex h-5 items-center justify-center">
                      <QuietDot status={d.status} kind="deployment" />
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex min-w-0 items-baseline gap-2 leading-5">
                        <span className="truncate text-[13.5px] font-medium text-fg">{d.serviceName}</span>
                        <span className="hidden truncate text-xs text-faint sm:inline">
                          {d.projectName} · {d.environmentName ?? "production"}
                        </span>
                      </span>
                      <span className="truncate text-[12.5px] text-muted">{d.commitMessage || (d.status === "failed" ? "Deployment failed" : "Redeployed")}</span>
                    </span>
                    <span className="hidden text-right font-mono text-[12px] leading-5 text-faint tabular-nums sm:block">{duration ?? ""}</span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
