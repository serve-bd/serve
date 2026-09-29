import Link from "next/link";
import { Box, Database, Layers } from "lucide-react";
import { StatusDot } from "@/components/ui/status";
import { TimeAgo } from "@/components/ui/misc";

export type ProjectSummary = {
  id: string;
  name: string;
  description: string | null;
  color: string;
  updatedAt: Date;
  services: { id: string; name: string; type: string; status: string }[];
};

const typeIcon = { app: Box, database: Database, compose: Layers } as const;

const typeLabel = { app: "App", database: "Database", compose: "Stack" } as const;

export function ProjectCard({ project }: { project: ProjectSummary }) {
  const total = project.services.length;
  const running = project.services.filter((s) => s.status === "running").length;
  const failing = project.services.filter((s) => s.status === "failed" || s.status === "crashed").length;
  const counts = (Object.keys(typeIcon) as (keyof typeof typeIcon)[]).map((t) => ({ t, n: project.services.filter((s) => s.type === t).length })).filter((c) => c.n);
  const health = total === 0 ? "idle" : failing ? "failed" : running === total ? "running" : "stopped";
  return (
    <Link
      href={`/projects/${project.id}`}
      className="group flex flex-col gap-4 rounded-xl border border-line bg-surface p-4 shadow-sm transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold text-fg">{project.name}</h3>
          <p className="truncate text-[13px] text-muted">
            {project.description || (
              <>
                Updated <TimeAgo date={project.updatedAt} />
              </>
            )}
          </p>
        </div>
        {failing > 0 && <span className="flex-none rounded-full bg-bad-soft px-2 py-0.5 text-[11px] font-medium text-bad">{failing} failing</span>}
      </div>
      <div className="flex items-center justify-between gap-3 text-xs text-muted">
        <div className="flex min-w-0 items-center gap-3">
          {counts.length ? (
            counts.map(({ t, n }) => {
              const Icon = typeIcon[t];
              return (
                <span key={t} className="inline-flex items-center gap-1" title={`${n} ${typeLabel[t].toLowerCase()}${n === 1 ? "" : "s"}`}>
                  <Icon className="size-3.5 text-faint" />
                  {n}
                </span>
              );
            })
          ) : (
            <span className="text-faint">No services yet</span>
          )}
        </div>
        {total > 0 && (
          <span className="inline-flex flex-none items-center gap-1.5 tabular-nums">
            <StatusDot status={health} />
            {running}/{total} running
          </span>
        )}
      </div>
    </Link>
  );
}
