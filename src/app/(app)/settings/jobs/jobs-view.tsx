"use client";

import * as React from "react";
import Link from "next/link";
import { CircleAlert, CircleCheck, Clock, Loader2, SkipForward } from "lucide-react";
import { Badge, Card, CardHeader, EmptyState, TimeAgo } from "@/components/ui/misc";
import { everyLabel, JOB_LABELS, SCHEDULER_LABELS } from "@/lib/jobs";
import { cn } from "@/lib/utils";

type Scheduler = {
  name: string;
  intervalMs: number;
  lastStartedAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastFailedAt: string | null;
  runs: number;
  failures: number;
  skipped: number;
  lastSkippedAt: string | null;
};

type JobRow = {
  id: string;
  type: string;
  status: string;
  runAt: string;
  lockedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  attempts: number;
  subject: { name: string; href: string } | null;
};

const duration = (ms: number | null) => (ms === null ? "" : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);
const label = (type: string) => JOB_LABELS[type] ?? type;

export function JobsView({
  heartbeat,
  schedulers,
  active,
  failed,
  done,
}: {
  heartbeat: string | null;
  schedulers: Scheduler[];
  active: JobRow[];
  failed: JobRow[];
  done: { type: string; count: number }[];
}) {
  const workerUp = !!heartbeat && Date.now() - new Date(heartbeat).getTime() < 90_000;
  const failing = schedulers.filter((s) => s.lastError);
  const running = active.filter((j) => j.status === "running");
  const waiting = active.filter((j) => j.status !== "running");
  const doneTotal = done.reduce((n, d) => n + d.count, 0);
  const [allFailed, setAllFailed] = React.useState(false);

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6">
      <Card>
        <CardHeader
          title="Background work"
          description={
            workerUp ? (
              <>
                The worker is running (last seen <TimeAgo date={heartbeat} />
                ). {failing.length ? `${failing.length} scheduler${failing.length === 1 ? "" : "s"} failed on the last run.` : "Every scheduler's last run went well."}
              </>
            ) : (
              <span className="text-bad">
                The worker has not reported in
                {heartbeat ? (
                  <>
                    {" "}
                    since <TimeAgo date={heartbeat} />
                  </>
                ) : (
                  ""
                )}
                : nothing below runs until it is back.
              </span>
            )
          }
        />
        <div className="grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-4">
          {[
            { label: "Running now", value: running.length },
            { label: "Waiting", value: waiting.length },
            { label: "Done, last 24 h", value: doneTotal },
            { label: "Failed, last 7 days", value: failed.length, bad: failed.length > 0 },
          ].map((f) => (
            <div key={f.label} className="flex flex-col gap-0.5 bg-surface px-5 py-3">
              <span className={cn("text-xl font-semibold tabular-nums", f.bad ? "text-bad" : "text-fg")}>{f.value}</span>
              <span className="text-xs text-muted">{f.label}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Schedulers" description="Work the worker repeats on its own. A run that is still going when the next is due skips that one." />
        {schedulers.length === 0 ? (
          <p className="border-t border-line px-5 py-4 text-[13px] text-muted">No runs recorded yet. They show up a minute after the worker starts.</p>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {[...failing, ...schedulers.filter((s) => !s.lastError)].map((s) => (
              <li key={s.name} className={cn("flex flex-col gap-1 px-5 py-3", s.lastError && "bg-bad-soft/40")}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {s.lastError ? <CircleAlert className="size-4 flex-none text-bad" /> : <CircleCheck className="size-4 flex-none text-ok" />}
                  <span className="text-[13.5px] font-medium text-fg">{SCHEDULER_LABELS[s.name] ?? s.name}</span>
                  <span className="text-xs text-muted">{everyLabel(s.intervalMs)}</span>
                  <span className="ml-auto flex flex-wrap items-center gap-x-3 text-xs text-muted">
                    {s.lastStartedAt && (
                      <span>
                        last <TimeAgo date={s.lastStartedAt} />
                        {s.lastDurationMs !== null && ` · ${duration(s.lastDurationMs)}`}
                      </span>
                    )}
                    <span className="tabular-nums">{s.runs} runs</span>
                    {s.failures > 0 && <span className="text-bad tabular-nums">{s.failures} failed</span>}
                    {s.skipped > 0 && (
                      <span
                        className="inline-flex items-center gap-1 text-warn tabular-nums"
                        title={s.lastSkippedAt ? `Last skipped ${new Date(s.lastSkippedAt).toLocaleString()}` : undefined}
                      >
                        <SkipForward className="size-3" /> {s.skipped} skipped
                      </span>
                    )}
                  </span>
                </div>
                {s.lastError && <p className="pl-7 font-mono text-[12px] leading-relaxed break-words text-bad">{s.lastError}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Queue" description="Jobs running now and waiting to run: deployments, backups, tasks and more." />
        {active.length === 0 ? (
          <p className="border-t border-line px-5 py-4 text-[13px] text-muted">Nothing running or waiting.</p>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {[...running, ...waiting].map((j) => (
              <JobItem key={j.id} job={j} />
            ))}
          </ul>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Failed jobs" description="The last 7 days, newest first." />
        {failed.length === 0 ? (
          <EmptyState icon={<CircleCheck />} title="No failures" description="Every job of the last 7 days finished." />
        ) : (
          <>
            <ul className="divide-y divide-line border-t border-line">
              {(allFailed ? failed : failed.slice(0, 10)).map((j) => (
                <JobItem key={j.id} job={j} />
              ))}
            </ul>
            {failed.length > 10 && (
              <button type="button" onClick={() => setAllFailed((v) => !v)} className="w-full border-t border-line px-5 py-2.5 text-left text-[13px] text-accent hover:bg-hover">
                {allFailed ? "Show the newest 10" : `Show all ${failed.length}`}
              </button>
            )}
          </>
        )}
      </Card>

      {done.length > 0 && (
        <p className="text-xs text-muted">
          Done in the last 24 hours:{" "}
          {done
            .sort((a, b) => b.count - a.count)
            .map((d) => `${label(d.type)} ${d.count}`)
            .join(" · ")}
        </p>
      )}
    </div>
  );
}

function JobItem({ job }: { job: JobRow }) {
  const due = job.status === "pending" && new Date(job.runAt).getTime() > Date.now();
  return (
    <li className="flex flex-col gap-1 px-5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {job.status === "running" ? (
          <Loader2 className="size-4 flex-none animate-spin text-info" />
        ) : job.status === "failed" ? (
          <CircleAlert className="size-4 flex-none text-bad" />
        ) : (
          <Clock className="size-4 flex-none text-muted" />
        )}
        <span className="text-[13.5px] font-medium text-fg">{label(job.type)}</span>
        {job.subject && (
          <Link href={job.subject.href} className="min-w-0 truncate text-[13px] text-accent hover:underline">
            {job.subject.name}
          </Link>
        )}
        {job.attempts > 1 && <Badge>try {job.attempts}</Badge>}
        <span className="ml-auto text-xs text-muted">
          {job.status === "running" ? (
            <>
              started <TimeAgo date={job.lockedAt ?? job.createdAt} />
            </>
          ) : job.status === "failed" ? (
            <TimeAgo date={job.finishedAt ?? job.createdAt} />
          ) : due ? (
            <>
              due <TimeAgo date={job.runAt} />
            </>
          ) : (
            <>
              waiting since <TimeAgo date={job.createdAt} />
            </>
          )}
        </span>
      </div>
      {job.error && <JobError text={job.error} />}
    </li>
  );
}

/** A long error stays three lines until clicked. */
function JobError({ text }: { text: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    // A div: browsers do not clamp the lines of a button.
    <div
      role="button"
      tabIndex={0}
      onClick={() => setOpen((v) => !v)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen((v) => !v))}
      title={open ? undefined : "Show all of it"}
      className={cn("cursor-pointer pl-7 font-mono text-[12px] leading-relaxed break-words text-bad", !open && "line-clamp-3")}
    >
      {text.slice(0, 4000)}
    </div>
  );
}
