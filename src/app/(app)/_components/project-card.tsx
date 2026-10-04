import Link from "next/link";
import { Tooltip } from "@/components/ui/tooltip";
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

function summary(project: ProjectSummary) {
  const total = project.services.length;
  const counts = (Object.keys(typeIcon) as (keyof typeof typeIcon)[]).map((t) => ({ t, n: project.services.filter((s) => s.type === t).length })).filter((c) => c.n);
  return { total, counts };
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

/**
 * The project's health in words, by its most important state: something failing, then something
 * deploying, then states Serve cannot tell, then stopped services, else all running.
 */
function Health({ services }: { services: ProjectSummary["services"] }) {
  const total = services.length;
  if (!total) return <span className="text-faint">Empty</span>;
  const count = (states: string[]) => services.filter((s) => states.includes(s.status)).length;
  const failing = count(["failed", "crashed"]);
  const busy = count(["building", "deploying", "restarting"]);
  const unknown = count(["unknown"]);
  const down = total - count(["running"]) - failing - busy - unknown;
  const [status, text] = failing
    ? ["failed", `${failing} failing`]
    : busy
      ? ["deploying", `${busy} deploying`]
      : unknown
        ? ["unknown", `${unknown} unknown`]
        : down
          ? ["stopped", `${down} stopped`]
          : ["running", "All running"];
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusDot status={status} />
      <span className={failing ? "text-bad" : undefined}>{text}</span>
    </span>
  );
}

/** A project as a row of the list view. */
export function ProjectRow({ project }: { project: ProjectSummary }) {
  const { total, counts } = summary(project);
  return (
    <Link href={`/projects/${project.id}`} className="group flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-fg/[0.025]">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-fg">{project.name}</span>
        </span>
        <span className="truncate text-xs text-muted">{project.description || (total ? `${total} service${total === 1 ? "" : "s"}` : "No services yet")}</span>
      </span>
      <span className="hidden w-32 flex-none items-center gap-3 text-xs text-muted sm:flex">
        <Counts counts={counts} />
      </span>
      <span className="w-28 flex-none text-xs text-muted tabular-nums">
        <Health services={project.services} />
      </span>
      <span className="hidden w-20 flex-none text-right text-xs text-faint lg:block">
        <TimeAgo date={project.updatedAt} />
      </span>
    </Link>
  );
}

export function ProjectCard({ project }: { project: ProjectSummary }) {
  const { total, counts } = summary(project);
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
      </div>
      <div className="flex items-center justify-between gap-3 text-xs text-muted">
        <div className="flex min-w-0 items-center gap-3">{counts.length ? <Counts counts={counts} /> : <span className="text-faint">No services yet</span>}</div>
        {total > 0 && (
          <span className="flex-none tabular-nums">
            <Health services={project.services} />
          </span>
        )}
      </div>
    </Link>
  );
}
