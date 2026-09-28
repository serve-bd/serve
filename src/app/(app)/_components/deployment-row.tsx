import Link from "next/link";
import { GitCommitHorizontal, RotateCcw, Upload, Webhook } from "lucide-react";
import { StatusDot, statusText } from "@/components/ui/status";
import { TimeAgo } from "@/components/ui/misc";
import { cn, formatDuration } from "@/lib/utils";

export type DeploymentRowData = {
  id: string;
  status: string;
  trigger: string;
  commitSha: string | null;
  commitMessage: string | null;
  branch: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  serviceId: string;
  serviceName?: string;
  projectId: string;
};

const triggerIcon: Record<string, React.ReactNode> = {
  webhook: <Webhook className="size-3" />,
  rollback: <RotateCcw className="size-3" />,
  "deploy-hook": <Webhook className="size-3" />,
};

const triggerLabel: Record<string, string> = {
  create: "Initial deployment",
  manual: "Manual deployment",
  redeploy: "Redeploy",
  rollback: "Rollback",
  webhook: "Git push",
  "deploy-hook": "Deploy hook",
  api: "API deployment",
};

export function DeploymentRow({ d, showService = true, current }: { d: DeploymentRowData; showService?: boolean; current?: boolean }) {
  const duration = d.startedAt && d.finishedAt ? formatDuration(new Date(d.finishedAt).getTime() - new Date(d.startedAt).getTime()) : null;
  return (
    <Link
      href={`/projects/${d.projectId}/services/${d.serviceId}/deployments/${d.id}`}
      className="group grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-0.5 px-4 py-3 transition-colors hover:bg-hover/50"
    >
      <StatusDot status={d.status} kind="deployment" />
      <div className="flex min-w-0 items-center gap-2">
        {showService && d.serviceName && <span className="shrink-0 text-[13px] font-medium text-fg">{d.serviceName}</span>}
        <span className="truncate text-[13px] text-fg-2">{d.commitMessage || triggerLabel[d.trigger] || "Deployment"}</span>
        {current && <span className="shrink-0 rounded-full bg-ok-soft px-1.5 text-[10px] font-semibold text-ok">CURRENT</span>}
      </div>
      <span className="text-right text-xs text-faint">
        <TimeAgo date={d.createdAt} />
      </span>
      <span />
      <div className="flex min-w-0 items-center gap-3 text-xs text-muted">
        <span className={cn(d.status === "failed" && "text-bad")}>{statusText(d.status, "deployment")}</span>
        {d.commitSha && (
          <span className="flex items-center gap-1 font-mono">
            <GitCommitHorizontal className="size-3" />
            {d.commitSha.slice(0, 7)}
          </span>
        )}
        {d.branch && <span className="truncate font-mono">{d.branch}</span>}
        <span className="flex items-center gap-1 capitalize">{triggerIcon[d.trigger] ?? <Upload className="size-3" />}{d.trigger}</span>
      </div>
      <span className="text-right text-xs text-faint tabular-nums">{duration}</span>
    </Link>
  );
}
