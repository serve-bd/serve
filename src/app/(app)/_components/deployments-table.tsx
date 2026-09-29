import Link from "next/link";
import { StatusLabel } from "@/components/ui/status";
import { TimeAgo } from "@/components/ui/misc";
import { cn, formatDuration } from "@/lib/utils";

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

const cols = "sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_7.5rem_6.5rem]";

/** Recent deployments as a table on wide screens, stacked rows on phones. */
export function DeploymentsTable({ rows }: { rows: DeploymentTableRow[] }) {
  return (
    <div role="table" className="text-[13px]">
      <div role="row" className={cn("hidden gap-4 border-b border-line bg-surface-2/40 px-5 py-2.5 text-xs font-medium text-muted sm:grid", cols)}>
        <span role="columnheader">Application</span>
        <span role="columnheader">Environment</span>
        <span role="columnheader">Server</span>
        <span role="columnheader">Status</span>
        <span role="columnheader" className="text-right">
          Started
        </span>
      </div>
      <div className="divide-y divide-line">
        {rows.map((d) => {
          const duration = d.startedAt && d.finishedAt ? formatDuration(new Date(d.finishedAt).getTime() - new Date(d.startedAt).getTime()) : null;
          return (
            <Link
              key={d.id}
              role="row"
              href={`/projects/${d.projectId}/services/${d.serviceId}/deployments/${d.id}`}
              className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-5 py-3 transition-colors hover:bg-hover/50", cols)}
            >
              <span role="cell" className="flex min-w-0 flex-col">
                <span className="truncate font-medium text-fg">{d.serviceName}</span>
                {d.commitMessage && <span className="truncate text-xs text-muted">{d.commitMessage}</span>}
              </span>
              <span role="cell" className="order-3 col-span-2 truncate text-xs text-muted sm:order-none sm:col-span-1 sm:text-[13px] sm:text-fg-2">
                {d.projectName} / {d.environmentName ?? "production"}
                <span className="sm:hidden">
                  {" "}
                  · {d.serverName ?? "—"} · <TimeAgo date={d.createdAt} />
                </span>
              </span>
              <span role="cell" className="hidden truncate text-fg-2 sm:block">
                {d.serverName ?? "—"}
              </span>
              <span role="cell" className="order-2 sm:order-none">
                <StatusLabel status={d.status} kind="deployment" className="rounded-full bg-surface-2 px-2 py-0.5 text-xs" />
              </span>
              <span role="cell" className="hidden flex-col items-end text-xs sm:flex">
                <TimeAgo date={d.createdAt} className="text-fg-2" />
                {duration && <span className="text-faint tabular-nums">{duration}</span>}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
