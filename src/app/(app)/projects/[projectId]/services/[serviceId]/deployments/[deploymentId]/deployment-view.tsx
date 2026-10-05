"use client";

import { toast } from "@/components/ui/toast";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "@/hooks/use-router";
import { AlertTriangle, ArrowLeft, Ban, Check, Clock, Hourglass, Container, GitBranch, GitCommitHorizontal, Play, RefreshCw, RotateCcw, Server, Upload, User } from "lucide-react";
import type { DeploymentTarget } from "@/server/services/types";
import { Button } from "@/components/ui/button";
import { Badge, Card, TimeAgo, Copyable } from "@/components/ui/misc";
import { StatusLabel } from "@/components/ui/status";
import { LogViewer, type LogLine } from "@/components/log-viewer";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { cancelDeployment, forceStartDeployment, redeployDeployment, rollbackTo } from "@/server/actions/services";
import { approveDeployment, rejectDeployment } from "@/server/actions/deploy-rules";
import { formatBytes, formatDuration } from "@/lib/utils";
import { triggerText } from "@/lib/labels";
import { useCan } from "@/components/permissions";

type Dep = {
  id: string;
  status: string;
  trigger: string;
  commitSha: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  branch: string | null;
  image: string | null;
  /** Files uploaded from the CLI that this deployment builds. */
  upload: { files: number; size: number; dirty: boolean } | null;
  createdAt: string;
  userName: string | null;
};

type LogState = {
  status: string;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  targets?: DeploymentTarget[] | null;
  registryImage?: string | null;
};

const targetTone: Record<DeploymentTarget["status"], "ok" | "bad" | "warn" | "neutral" | "info"> = {
  success: "ok",
  failed: "bad",
  skipped: "warn",
  deploying: "info",
  pending: "neutral",
};
const targetLabel: Record<DeploymentTarget["status"], string> = { success: "Deployed", failed: "Failed", skipped: "Skipped", deploying: "Deploying", pending: "Waiting" };

const ACTIVE = ["waiting", "queued", "building", "deploying"];

export function DeploymentView({
  deployment,
  backHref,
  serviceType,
  isCurrent,
  repoUrl,
}: {
  deployment: Dep;
  backHref: string;
  serviceType: string;
  isCurrent: boolean;
  repoUrl: string | null;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const can = useCan();
  const [lines, setLines] = React.useState<LogLine[]>([]);
  const [state, setState] = React.useState<LogState>({ status: deployment.status, error: null, startedAt: null, finishedAt: null });
  const [now, setNow] = React.useState(() => Date.now());
  const offset = React.useRef(0);
  const partial = React.useRef("");

  React.useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    // React may run this effect twice in development; the first run is discarded below.
    offset.current = 0;
    partial.current = "";
    const tick = async () => {
      try {
        const res = await fetch(`/api/deployments/${deployment.id}/logs?offset=${offset.current}`);
        if (stopped) return;
        // The role cannot read build logs: asking again every second would never change that.
        if (res.status === 403) {
          const message = await res.text();
          if (!stopped) setLines([{ text: message }]);
          return;
        }
        if (res.ok) {
          const data = (await res.json()) as LogState & { chunk: string; offset: number; reset: boolean };
          // A cancelled run must not append what it fetched.
          if (stopped) return;
          if (data.reset) {
            partial.current = "";
            setLines([]);
          }
          if (data.chunk) {
            const text = partial.current + data.chunk;
            const parts = text.split("\n");
            partial.current = parts.pop() ?? "";
            setLines((prev) => [...prev, ...parts.map((p) => ({ text: p }))]);
          }
          offset.current = data.offset;
          setState({
            status: data.status,
            error: data.error,
            startedAt: data.startedAt,
            finishedAt: data.finishedAt,
            targets: data.targets,
            registryImage: data.registryImage,
          });
          if (!ACTIVE.includes(data.status)) {
            if (partial.current) setLines((prev) => [...prev, { text: partial.current }]);
            partial.current = "";
            router.refresh();
            return;
          }
        }
      } catch {
        // retry
      }
      if (!stopped) timer = setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [deployment.id, router]);

  const active = ACTIVE.includes(state.status);
  React.useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  // No toast for the request: the button waits, and one toast reports how it ended.
  const [cancelling, setCancelling] = React.useState(false);
  const cancel = useAction(() => cancelDeployment(deployment.id), { refresh: false, onSuccess: () => setCancelling(true) });
  React.useEffect(() => {
    if (!cancelling || active) return;
    setCancelling(false);
    if (state.status !== "cancelled") toast.info(`The deployment ${state.status === "success" ? "finished" : state.status} before it could be cancelled`);
  }, [cancelling, active, state.status]);
  // The page follows the status live: it shows "building" when the forced start begins.
  const forceStart = useAction(() => forceStartDeployment(deployment.id), { refresh: false });
  const approve = useAction(() => approveDeployment(deployment.id), { refresh: false });
  const reject = useAction(() => rejectDeployment(deployment.id), { refresh: false });
  const redeploy = useAction(() => redeployDeployment(deployment.id), {
    onSuccess: (d) => router.push(`${backHref}/${d.id}`),
  });
  const rollback = useAction(() => rollbackTo(deployment.id), {
    onSuccess: (d) => router.push(`${backHref}/${d.id}`),
  });

  const started = state.startedAt ? new Date(state.startedAt).getTime() : null;
  const finished = state.finishedAt ? new Date(state.finishedAt).getTime() : null;
  const elapsed = started ? formatDuration((finished ?? now) - started) : null;

  return (
    <div className="flex flex-col gap-5">
      <Link href={backHref} className="inline-flex w-fit items-center gap-1.5 text-[13px] text-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> All deployments
      </Link>

      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2.5">
              <StatusLabel status={state.status} kind="deployment" className="text-[15px]" />
              {isCurrent && <Badge tone="ok">Current</Badge>}
              <span className="font-mono text-xs text-faint">{deployment.id}</span>
            </div>
            <h2 className="text-[17px] font-semibold text-fg">{deployment.commitMessage || (deployment.trigger === "rollback" ? "Rollback" : "Deployment")}</h2>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
              {deployment.commitSha && (
                <a
                  href={repoUrl?.startsWith("http") ? `${repoUrl}/commit/${deployment.commitSha}` : undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono hover:text-fg"
                >
                  <GitCommitHorizontal className="size-3.5" />
                  {deployment.commitSha.slice(0, 7)}
                </a>
              )}
              {deployment.branch && (
                <span className="inline-flex items-center gap-1 font-mono">
                  <GitBranch className="size-3.5" />
                  {deployment.branch}
                </span>
              )}
              {deployment.upload && (
                <span className="inline-flex items-center gap-1" title={`${formatBytes(deployment.upload.size)} uploaded`}>
                  <Upload className="size-3.5" />
                  {deployment.upload.files} {deployment.upload.files === 1 ? "file" : "files"}
                  {deployment.upload.dirty && " + local changes"}
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <User className="size-3.5" />
                {deployment.userName ?? deployment.commitAuthor ?? "System"} · {triggerText(deployment.trigger)}
              </span>
              <span className="inline-flex items-center gap-1">
                <Clock className="size-3.5" />
                <TimeAgo date={deployment.createdAt} />
                {elapsed && <span className="tabular-nums"> · {elapsed}</span>}
              </span>
            </div>
          </div>
          {can("services.deploy") && (
            <div className="flex items-center gap-2">
              {active ? (
                <>
                  {state.status === "queued" && !cancelling && (
                    <Button
                      size="sm"
                      title="Start now, without waiting for a free build slot on the server"
                      onClick={async () => {
                        if (
                          await confirm({
                            title: "Start this deployment now?",
                            description:
                              "It skips the queue and builds next to the builds already running, past the server's limit of concurrent builds. A deployment of this service that is running or waiting before it is cancelled.",
                            confirmLabel: "Force start",
                          })
                        )
                          forceStart.run();
                      }}
                      loading={forceStart.pending}
                    >
                      <Play /> Force start
                    </Button>
                  )}
                  <Button variant="danger-ghost" size="sm" onClick={() => cancel.run()} loading={cancel.pending || cancelling} disabled={cancelling}>
                    {!(cancel.pending || cancelling) && <Ban />} {cancelling ? "Cancelling…" : "Cancel"}
                  </Button>
                </>
              ) : (
                <>
                  {serviceType === "app" && state.status === "success" && !isCurrent && deployment.image && (
                    <Button
                      size="sm"
                      onClick={async () => {
                        if (await confirm({ title: "Roll back to this deployment?", description: "Its image starts again without rebuilding.", confirmLabel: "Roll back" }))
                          rollback.run();
                      }}
                      loading={rollback.pending}
                    >
                      <RotateCcw /> Roll back
                    </Button>
                  )}
                  <Button size="sm" onClick={() => redeploy.run()} loading={redeploy.pending}>
                    <RefreshCw /> Redeploy
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
        {state.status === "waiting" && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-warn-soft px-4 py-3">
            <Hourglass className="size-4 flex-none text-warn" />
            <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-fg-2">
              {can("deploys.approve") ? "This deployment waits for approval. It starts once you approve it." : "This deployment waits for someone who can approve deploys."}
            </p>
            {can("deploys.approve") && (
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => reject.run()} loading={reject.pending} disabled={approve.pending}>
                  <Ban /> Reject
                </Button>
                <Button size="sm" variant="primary" onClick={() => approve.run()} loading={approve.pending} disabled={reject.pending}>
                  <Check /> Approve
                </Button>
              </div>
            )}
          </div>
        )}
        {state.status === "cancelled" && state.error && <p className="mt-4 rounded-xl bg-hover px-4 py-3 text-[13px] leading-relaxed text-fg-2">{state.error}</p>}
        {state.status === "failed" && state.error && (
          <Copyable value={state.error} className="mt-4">
            <pre className="max-h-48 overflow-auto rounded-xl bg-bad-soft py-3 pr-10 pl-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-bad">{state.error}</pre>
          </Copyable>
        )}
        {/* Several servers: the deployment succeeded on the service's server, some others may have failed. */}
        {state.status === "success" && state.error && (
          <p className="mt-4 rounded-xl bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-fg-2">
            <AlertTriangle className="mr-1.5 inline size-4 -translate-y-px text-warn" />
            {state.error}. Those servers keep the previous version.
          </p>
        )}
        {(state.targets?.length || state.registryImage) && (
          <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4">
            {state.targets && state.targets.length > 1 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-faint">Servers</span>
                {state.targets.map((t) => (
                  <span key={t.serverId} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-[12px] text-fg-2" title={t.error ?? undefined}>
                    <Server className="size-3.5 text-faint" />
                    {t.name}
                    {t.primary && <span className="text-faint">· main</span>}
                    <Badge tone={targetTone[t.status]}>{targetLabel[t.status]}</Badge>
                  </span>
                ))}
              </div>
            )}
            {state.registryImage && (
              <p className="flex min-w-0 items-center gap-2 text-xs text-muted">
                <Container className="size-3.5 flex-none text-faint" />
                <span className="truncate font-mono" title={state.registryImage}>
                  {state.registryImage}
                </span>
              </p>
            )}
          </div>
        )}
      </Card>

      <LogViewer
        lines={lines}
        filename={`deployment-${deployment.id}.log`}
        emptyText={state.status === "waiting" ? "Waiting for approval…" : state.status === "queued" ? "Waiting for the build to start…" : "Waiting for output…"}
      />
    </div>
  );
}
