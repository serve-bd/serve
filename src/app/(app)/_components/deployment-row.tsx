import Link from "next/link";
import { GitCommitHorizontal, RotateCcw, Upload, Webhook } from "lucide-react";
import { StatusDot, statusText } from "@/components/ui/status";
import { TimeAgo } from "@/components/ui/misc";
import { cn, formatDuration } from "@/lib/utils";
import { triggerText } from "@/lib/labels";

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
  const title = d.commitMessage || triggerLabel[d.trigger] || "Deployment";
  const settled = d.status === "success";
  return (
    <Link
      href={`/projects/${d.projectId}/services/${d.serviceId}/deployments/${d.id}`}
      className="group flex items-center gap-3.5 px-5 py-3 transition-colors hover:bg-hover/50"
    >
      <StatusDot status={d.status} kind="deployment" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          {showService && d.serviceName && <span className="shrink-0 text-[13px] font-medium text-fg">{d.serviceName}</span>}
          {d.commitMessage && <span className="truncate text-[13px] text-fg-2">{d.commitMessage}</span>}
          {current && <span className="shrink-0 self-center rounded-full bg-ok-soft px-1.5 text-[10px] font-semibold text-ok">CURRENT</span>}
          <span className="ml-auto pl-2 shrink-0 text-xs text-faint">
            <TimeAgo date={d.createdAt} />
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
          {!settled && <span className={cn("shrink-0 font-medium", d.status === "failed" ? "text-bad" : "text-fg-2")}>{statusText(d.status, "deployment")}</span>}
          {!settled && <span className="text-faint">·</span>}
          <span className="flex shrink-0 items-center gap-1">
            {triggerIcon[d.trigger] ?? <Upload className="size-3" />}
            {d.commitMessage ? triggerText(d.trigger) : title}
          </span>
          {d.commitSha && <span className="text-faint">·</span>}
          {d.commitSha && (
            <span className="flex shrink-0 items-center gap-1 font-mono">
              <GitCommitHorizontal className="size-3" />
              {d.commitSha.slice(0, 7)}
            </span>
          )}
          {d.branch && <span className="hidden shrink-0 truncate font-mono sm:inline">{d.branch}</span>}
          {duration && <span className="ml-auto shrink-0 pl-2 text-faint tabular-nums">{duration}</span>}
        </div>
      </div>
    </Link>
  );
}
