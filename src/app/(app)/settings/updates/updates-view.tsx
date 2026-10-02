"use client";

import * as React from "react";
import { ArrowUpRight, Check, CircleAlert, CircleCheck, Download, Info, Loader2, Package, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardBody, CardHeader, Copyable, CopyButton, TimeAgo } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { useProductName } from "@/components/brand";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { useRouter } from "@/hooks/use-router";
import { checkUpdatesNow, startSelfUpdate, updateStatus } from "@/server/actions/instance";
import { UpdateSchedule, type UpdateScheduleSettings } from "./update-schedule";
import type { UpdateCheck, UpdateRun } from "@/server/settings";

const runLabel: Record<UpdateRun["state"], { label: string; tone: "info" | "ok" | "bad" }> = {
  "backing-up": { label: "Backing up", tone: "info" },
  running: { label: "Updating", tone: "info" },
  success: { label: "Updated", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  "rolled-back": { label: "Rolled back", tone: "bad" },
};

export type Component = { name: string; value: string; note: string; ok: boolean };

export function UpdatesView({
  version,
  commit,
  repository,
  mode,
  schedule,
  check,
  available,
  run: initialRun,
  components,
}: {
  version: string;
  commit: string | null;
  repository: string;
  mode: "compose" | "manual";
  schedule: UpdateScheduleSettings;
  check: UpdateCheck | null;
  available: boolean;
  run: UpdateRun | null;
  components: Component[];
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const productName = useProductName();
  const [run, setRun] = React.useState(initialRun);
  // A refresh brings newer stored progress: take it over the last polled value.
  const [seenRun, setSeenRun] = React.useState(initialRun);
  if (initialRun !== seenRun) {
    setSeenRun(initialRun);
    setRun(initialRun);
  }
  const [live, setLive] = React.useState<string | null>(null);
  // Polls that fail while an update runs: the dashboard is restarting on the new version.
  const [unreachable, setUnreachable] = React.useState(false);
  // Set once "Update now" succeeds, until polling sees the run it started (an id other than `startedFrom`).
  const [starting, setStarting] = React.useState(false);
  const startedFrom = React.useRef<string | null>(null);
  const checkNow = useAction(checkUpdatesNow, { result: (c) => (c.latest ? `Latest release: v${c.latest}` : "No releases published yet") });
  const start = useAction(startSelfUpdate, {
    onSuccess: () => {
      startedFrom.current = run?.id ?? null;
      setStarting(true);
    },
  });
  const active = run?.state === "backing-up" || run?.state === "running";

  // While an update runs the dashboard restarts; keep polling and reload once it is back.
  React.useEffect(() => {
    if (!active && !start.pending && !starting) return;
    const t = setInterval(async () => {
      const res = await updateStatus().catch(() => null);
      if (!res?.ok) {
        setUnreachable(true);
        return;
      }
      setUnreachable(false);
      const next = res.data.run;
      // Before the new run shows up, the stored one is the previous update: keep waiting.
      if (starting && (!next || next.id === startedFrom.current)) return;
      setStarting(false);
      setRun(next);
      setLive(res.data.live);
      if (next && next.state !== "backing-up" && next.state !== "running") router.refresh();
    }, 3000);
    return () => clearInterval(t);
  }, [active, start.pending, starting, router]);

  const log = `${run?.log ?? ""}${live ?? ""}`.trim();
  const lastLine = log.split("\n").filter(Boolean).at(-1) ?? "";
  const busy = active || starting;

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center gap-4 px-5 py-5">
          <span
            className={cn(
              "flex size-11 flex-none items-center justify-center rounded-xl [&_svg]:size-5",
              available ? "bg-accent-soft text-accent" : check?.error ? "bg-warn-soft text-warn" : check?.latest ? "bg-ok-soft text-ok" : "bg-fg/[0.05] text-muted",
            )}
          >
            {available ? <Sparkles /> : check?.error ? <CircleAlert /> : check?.latest ? <CircleCheck /> : <Package />}
          </span>
          <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
            <p className="text-[15px] font-semibold text-fg">
              {available && check?.latest
                ? `${productName} v${check.latest} is available`
                : check?.error
                  ? "Could not check for updates"
                  : check?.latest
                    ? `${productName} is up to date`
                    : check
                      ? "No releases published yet"
                      : "Not checked yet"}
            </p>
            <p className="text-[13px] text-muted">
              {check?.error
                ? check.error
                : check?.latest
                  ? `You run v${version}. The newest release is v${check.latest}.`
                  : `You run v${version}. Updates appear here once github.com/${repository} publishes a release.`}
            </p>
          </div>
          <Button size="sm" onClick={() => checkNow.run()} loading={checkNow.pending} className="ml-auto flex-none">
            <RefreshCw /> Check now
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-px border-y border-line bg-line sm:grid-cols-4">
          <Fact label="Running" value={<span className="font-medium">v{version}</span>} />
          <Fact
            label="Commit"
            value={
              commit ? (
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-[12.5px]" title={commit}>
                    {commit.slice(0, 7)}
                  </span>
                  <CopyButton value={commit} />
                </span>
              ) : (
                "—"
              )
            }
          />
          <Fact
            label="Latest release"
            value={
              check?.latest ? (
                check.url ? (
                  <a href={check.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent hover:underline">
                    v{check.latest} <ArrowUpRight className="size-3.5" />
                  </a>
                ) : (
                  `v${check.latest}`
                )
              ) : (
                "None"
              )
            }
          />
          <Fact label="Last checked" value={check ? <TimeAgo date={check.checkedAt} /> : "Never"} />
        </div>
        <CardBody className="flex flex-col gap-4 py-5">
          {available && check?.latest ? (
            <div className="flex flex-col gap-3 rounded-xl border border-accent/30 bg-accent-soft/40 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Sparkles className="size-4 text-accent" />
                <span className="text-[14px] font-medium text-fg">
                  Update available: v{version} → v{check.latest}
                </span>
                {check.url && (
                  <a href={check.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[13px] text-accent hover:underline">
                    What changed <ArrowUpRight className="size-3.5" />
                  </a>
                )}
              </div>
              {check.notes && <pre className="max-h-48 overflow-auto rounded-lg bg-surface px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-fg-2">{check.notes}</pre>}
              {busy ? (
                <UpdateProgress state={starting && !active ? "backing-up" : (run?.state ?? "backing-up")} unreachable={unreachable} lastLine={lastLine} />
              ) : mode === "compose" ? (
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="primary"
                    size="sm"
                    loading={start.pending}
                    disabled={active}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: `Update to v${check.latest}?`,
                          description: `${productName} backs itself up, pulls the new version and restarts the dashboard, the worker and the database. If the new version does not start correctly, it goes back to v${version} by itself. The dashboard is unavailable for a minute or two; deployed services keep running.`,
                          confirmLabel: "Back up and update",
                        })
                      )
                        start.run();
                    }}
                  >
                    <Download /> Update now
                  </Button>
                  <span className="text-xs text-muted">A backup of this instance is taken before anything changes.</span>
                </div>
              ) : (
                <ManualSteps />
              )}
            </div>
          ) : null}

          <UpdateSchedule initial={schedule} canAutoUpdate={mode === "compose"} />
        </CardBody>
      </Card>

      {run && (
        <Card>
          <CardHeader
            title={`Update to v${run.to}`}
            description={
              <>
                Started <TimeAgo date={run.startedAt} /> from v{run.from}
              </>
            }
            actions={<Badge tone={runLabel[run.state].tone}>{runLabel[run.state].label}</Badge>}
          />
          <CardBody className="py-4">
            <Copyable value={log} dark>
              <pre className="max-h-80 overflow-auto rounded-xl bg-log-bg py-3 pr-10 pl-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-log-fg">
                {log || "Waiting for the worker to start the update…"}
              </pre>
            </Copyable>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="What an update changes" description={`One update moves every part below to the versions tested with that release of ${productName}.`} />
        <div className="divide-y divide-line">
          {components.map((c, i) => (
            <div key={`${c.name}-${i}`} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:gap-4">
              <div className="flex min-w-0 flex-col gap-0.5 sm:flex-1">
                <span className="text-[13px] font-medium text-fg">{c.name}</span>
                <span className="text-xs text-muted">{c.note}</span>
              </div>
              <span className={cn("min-w-0 break-all font-mono text-[12px] sm:max-w-[45%] sm:text-right", c.ok ? "text-fg-2" : "text-warn")}>
                {c.value}
                {!c.ok && c.name === "Worker" && <span className="font-sans"> · restart it to match</span>}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 bg-surface px-5 py-3">
      <span className="text-[11px] text-faint">{label}</span>
      <span className="truncate text-[13px] text-fg">{value}</span>
    </div>
  );
}

function ManualSteps() {
  return (
    <p className="flex items-start gap-2 rounded-xl border border-line bg-sunken px-3 py-2.5 text-[13px] leading-relaxed text-fg-2">
      <Info className="mt-0.5 size-4 flex-none text-muted" />
      <span>
        One-click updates work on the Docker install. This instance runs outside Docker (a development setup), so it cannot replace itself. Install with{" "}
        <span className="font-mono text-[12px]">install.sh</span> to update from here.
      </span>
    </p>
  );
}

const STEPS = [
  { id: "backing-up", label: "Backing up this instance" },
  { id: "running", label: "Installing the new version and restarting" },
  { id: "done", label: "Back online" },
] as const;

/** Where a running update is, shown in place of the Update now button. */
function UpdateProgress({ state, unreachable, lastLine }: { state: UpdateRun["state"]; unreachable: boolean; lastLine: string }) {
  const at = state === "backing-up" ? 0 : state === "running" ? 1 : 2;
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-surface px-4 py-3">
      <ol className="flex flex-col gap-2">
        {STEPS.map((step, i) => (
          <li key={step.id} className={cn("flex items-center gap-2.5 text-[13px]", i === at ? "text-fg" : i < at ? "text-fg-2" : "text-faint")}>
            <span className="flex size-4 flex-none items-center justify-center">
              {i < at ? (
                <Check className="size-3.5 text-ok" />
              ) : i === at ? (
                <Loader2 className="size-3.5 animate-spin text-accent" />
              ) : (
                <span className="size-1.5 rounded-full bg-line-strong" />
              )}
            </span>
            {step.label}
          </li>
        ))}
      </ol>
      <p className="truncate font-mono text-[11.5px] text-muted" title={lastLine}>
        {unreachable ? "The dashboard is restarting on the new version. This page reloads when it is back." : lastLine || "Starting…"}
      </p>
    </div>
  );
}
