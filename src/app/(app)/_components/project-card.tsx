import Link from "next/link";
import { Box, Database, Layers } from "lucide-react";
import { StatusDot } from "@/components/ui/status";
import { TimeAgo } from "@/components/ui/misc";
import { projectColor } from "@/components/shell/project-color";

export type ProjectSummary = {
  id: string;
  name: string;
  description: string | null;
  color: string;
  updatedAt: Date;
  services: { id: string; name: string; type: string; status: string }[];
};

const typeIcon = { app: Box, database: Database, compose: Layers } as const;

export function ProjectCard({ project }: { project: ProjectSummary }) {
  const running = project.services.filter((s) => s.status === "running").length;
  const failing = project.services.filter((s) => s.status === "failed" || s.status === "crashed").length;
  return (
    <Link
      href={`/projects/${project.id}`}
      className="group relative flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md"
    >
      <span className="absolute inset-x-0 top-0 h-0.5" style={{ background: projectColor(project.color) }} />
      <div className="flex flex-col gap-1 px-4 pt-4 pb-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="truncate text-[15px] font-semibold text-fg">{project.name}</h3>
          {failing > 0 && <span className="text-[11px] font-medium text-bad">{failing} failing</span>}
        </div>
        <p className="line-clamp-1 text-[13px] text-muted">{project.description || `${project.services.length} service${project.services.length === 1 ? "" : "s"}`}</p>
      </div>
      <div className="flex flex-1 flex-col gap-1 px-4 pb-3">
        {project.services.slice(0, 4).map((s) => {
          const Icon = typeIcon[s.type as keyof typeof typeIcon] ?? Box;
          return (
            <div key={s.id} className="flex items-center gap-2 text-[13px] text-fg-2">
              <Icon className="size-3.5 text-faint" />
              <span className="flex-1 truncate">{s.name}</span>
              <StatusDot status={s.status} />
            </div>
          );
        })}
        {project.services.length > 4 && <p className="text-xs text-faint">+{project.services.length - 4} more</p>}
        {project.services.length === 0 && <p className="text-[13px] text-faint">No services yet</p>}
      </div>
      <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-xs text-faint">
        <span>
          {running}/{project.services.length} running
        </span>
        <TimeAgo date={project.updatedAt} />
      </div>
    </Link>
  );
}
