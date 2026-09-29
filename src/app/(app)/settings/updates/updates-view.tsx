"use client";

import * as React from "react";
import { ArrowUpRight, CircleCheck, Download, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardBody, CardHeader, CopyField, TimeAgo } from "@/components/ui/misc";
import { SwitchRow } from "@/components/ui/switch";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { useRouter } from "@/hooks/use-router";
import { checkUpdatesNow, setUpdateCheckEnabled, startSelfUpdate, updateStatus } from "@/server/actions/instance";
import type { UpdateCheck, UpdateRun } from "@/server/settings";

const runLabel: Record<UpdateRun["state"], { label: string; tone: "info" | "ok" | "bad" }> = {
  "backing-up": { label: "Backing up", tone: "info" },
  running: { label: "Updating", tone: "info" },
  success: { label: "Updated", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
};

export function UpdatesView({
  version,
  commit,
  repository,
  mode,
  enabled,
  check,
  available,
  run: initialRun,
}: {
  version: string;
  commit: string | null;
  repository: string;
  mode: "compose" | "manual";
  enabled: boolean;
  check: UpdateCheck | null;
  available: boolean;
  run: UpdateRun | null;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [run, setRun] = React.useState(initialRun);
  const [live, setLive] = React.useState<string | null>(null);
  const checkNow = useAction(checkUpdatesNow, { success: (c) => (c.latest ? `Latest release: v${c.latest}` : "No releases published yet") });
  const toggle = useAction(setUpdateCheckEnabled, { success: "Saved" });
  const start = useAction(startSelfUpdate, { success: "Update started" });
  const active = run?.state === "backing-up" || run?.state === "running";

  // While an update runs the dashboard restarts; keep polling and reload once it is back.
  React.useEffect(() => {
    if (!active && !start.pending) return;
    const t = setInterval(async () => {
      const res = await updateStatus().catch(() => null);
      if (!res?.ok) return;
      setRun(res.data.run);
      setLive(res.data.live);
      if (res.data.run && res.data.run.state !== "backing-up" && res.data.run.state !== "running") router.refresh();
    }, 3000);
    return () => clearInterval(t);
  }, [active, start.pending, router]);

  const log = `${run?.log ?? ""}${live ?? ""}`.trim();

  return (
    <>
      <Card>
        <CardHeader
          title="Version"
          description={`Releases come from github.com/${repository}.`}
          actions={
            <Button size="sm" onClick={() => checkNow.run()} loading={checkNow.pending}>
              <RefreshCw /> Check now
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-4 py-5">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
            <span>
              <span className="text-muted">Running </span>
              <span className="font-medium text-fg">v{version}</span>
            </span>
            {commit && (
              <span className="font-mono text-xs text-muted" title={commit}>
                {commit.slice(0, 7)}
              </span>
            )}
            {check && (
              <span className="text-xs text-muted">
                Checked <TimeAgo date={check.checkedAt} />
              </span>
            )}
          </div>

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
              {mode === "compose" ? (
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
                          description:
                            "Serve backs itself up first, then pulls the new image and restarts. The dashboard is unavailable for a minute; deployed services keep running.",
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
          ) : (
            check &&
            !check.error && (
              <p className="flex items-center gap-2 text-[13px] text-fg-2">
                <CircleCheck className="size-4 text-ok" /> {check.latest ? "Serve is up to date." : "No releases are published yet."}
              </p>
            )
          )}
          {check?.error && <p className="text-xs text-warn">Last check failed: {check.error}</p>}

          <SwitchRow
            title="Check for updates"
            description="Asks GitHub for the newest release every few hours. Nothing about this instance is sent."
            checked={enabled}
            onCheckedChange={(c) => toggle.run(c)}
          />
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
            <pre className="max-h-80 overflow-auto rounded-xl bg-log-bg px-4 py-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-log-fg">
              {log || "Waiting for the worker…"}
            </pre>
          </CardBody>
        </Card>
      )}

      {mode === "manual" && !available && (
        <Card>
          <CardHeader title="Updating this installation" description="This instance runs from a checkout, not the Docker Compose install, so it is updated by hand." />
          <CardBody className="py-5">
            <ManualSteps />
          </CardBody>
        </Card>
      )}
    </>
  );
}

function ManualSteps() {
  return (
    <div className="flex flex-col gap-2 text-[13px] text-fg-2">
      <p>Run in the repository, then restart the web and worker processes:</p>
      <CopyField value="git pull && pnpm install && pnpm db:migrate && pnpm build && pnpm build:worker" />
    </div>
  );
}
