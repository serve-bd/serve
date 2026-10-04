import Link from "next/link";
import { Tooltip } from "@/components/ui/tooltip";
import { Box, Database, Layers } from "lucide-react";
import { StatusDot, statusColor, statusText } from "@/components/ui/status";
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

function summary(project: ProjectSummary) {
  const total = project.services.length;
  const running = project.services.filter((s) => s.status === "running").length;
  const failing = project.services.filter((s) => s.status === "failed" || s.status === "crashed").length;
  const counts = (Object.keys(typeIcon) as (keyof typeof typeIcon)[]).map((t) => ({ t, n: project.services.filter((s) => s.type === t).length })).filter((c) => c.n);
  const health = total === 0 ? "idle" : failing ? "failed" : running === total ? "running" : "stopped";
  return { total, running, failing, counts, health };
}

function Counts({ counts }: { counts: ReturnType<typeof summary>["counts"] }) {
  return counts.map(({ t, n }) => {
    const Icon = typeIcon[t];
    return (
      <Tooltip key={t} content={`${n} ${typeLabel[t].toLowerCase()}${n === 1 ? "" : "s"}`} delay={0}>
        <span className="inline-flex items-center gap-1">
          <Icon className="size-3.5 text-faint" />
          {n}
        </span>
      </Tooltip>
    );
  });
}

/** One bar per service, colored by its status: the health of a project at a glance. */
function HealthStrip({ services }: { services: ProjectSummary["services"] }) {
  const shown = services.slice(0, 16);
  return (
    <span className="flex h-2 w-full items-stretch gap-[3px]" aria-hidden>
      {shown.map((s) => (
        <Tooltip key={s.id} content={`${s.name}: ${statusText(s.status)}`} delay={0}>
          <span className="min-w-1 flex-1 rounded-full" style={{ background: statusColor(s.status), opacity: s.status === "running" ? 1 : 0.75 }} />
        </Tooltip>
      ))}
    </span>
  );
}

/** A project as a row of the list view. */
export function ProjectRow({ project }: { project: ProjectSummary }) {
  const { total, running, failing, counts, health } = summary(project);
  return (
    <Link href={`/projects/${project.id}`} className="group flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-fg/[0.025]">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-fg">{project.name}</span>
          {failing > 0 && <span className="flex-none rounded-full bg-bad-soft px-2 py-px text-[11px] font-medium text-bad">{failing} failing</span>}
        </span>
        <span className="truncate text-xs text-muted">{project.description || (total ? `${total} service${total === 1 ? "" : "s"}` : "No services yet")}</span>
      </span>
      <span className="hidden w-40 flex-none md:block">{total > 0 && <HealthStrip services={project.services} />}</span>
      <span className="hidden w-32 flex-none items-center gap-3 text-xs text-muted sm:flex">
        <Counts counts={counts} />
      </span>
      <span className="inline-flex w-24 flex-none items-center gap-1.5 text-xs text-muted tabular-nums">
        {total > 0 ? (
          <>
            <StatusDot status={health} />
            {running}/{total} running
          </>
        ) : (
          <span className="text-faint">Empty</span>
        )}
      </span>
      <span className="hidden w-20 flex-none text-right text-xs text-faint lg:block">
        <TimeAgo date={project.updatedAt} />
      </span>
    </Link>
  );
}

export function ProjectCard({ project }: { project: ProjectSummary }) {
  const { total, running, failing, counts, health } = summary(project);
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
        <div className="flex min-w-0 items-center gap-3">{counts.length ? <Counts counts={counts} /> : <span className="text-faint">No services yet</span>}</div>
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
