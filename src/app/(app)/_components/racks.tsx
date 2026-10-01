import Link from "next/link";
import { StatusDot, statusText } from "@/components/ui/status";
import { serverReachable } from "@/lib/server-services";
import { cn } from "@/lib/utils";
import type { ProjectSummary } from "./project-card";

export type ServerCardData = {
  id: string;
  name: string;
  host: string;
  isLocal: boolean;
  status: string;
  services: number;
  running: number;
  /** Off: the card shows status only, no usage. */
  metricsEnabled: boolean;
  series: { t: number; cpu: number; memory: number; memoryLimit: number; disk: number | null; diskTotal: number | null }[];
};

/** Row padding: wide inside a card, flush with the title when the widget has no card. */
export const ROW_PAD = "px-5 group-data-[frame=plain]/frame:-mx-2 group-data-[frame=plain]/frame:rounded-lg group-data-[frame=plain]/frame:px-2";

/** One project: a status light per service, like the lamps on a rack unit. */
export function ProjectRow({ project }: { project: ProjectSummary }) {
  const total = project.services.length;
  const running = project.services.filter((s) => s.status === "running").length;
  return (
    <Link href={`/projects/${project.id}`} className={cn("flex items-center gap-3 py-3 transition-colors hover:bg-hover/60", ROW_PAD)}>
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-fg">{project.name}</span>
      <span className="flex max-w-[45%] flex-wrap justify-end gap-x-2 gap-y-1.5" aria-hidden>
        {project.services.map((s) => (
          <span key={s.id} title={`${s.name}: ${statusText(s.status)}`} className="flex">
            <StatusDot status={s.status} />
          </span>
        ))}
      </span>
      <span className="w-9 flex-none text-right font-mono text-[12px] text-faint tabular-nums">{total ? `${running}/${total}` : "0"}</span>
    </Link>
  );
}

function Meter({ label, value }: { label: string; value: number | null }) {
  const pct = value === null ? null : Math.max(0, Math.min(100, value));
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-faint">{label}</span>
        <span className="font-mono text-fg-2 tabular-nums">{pct === null ? "–" : `${Math.round(pct)}%`}</span>
      </span>
      <span className="h-1 overflow-hidden rounded-full bg-sunken">
        <span className={cn("block h-full rounded-full", pct !== null && pct > 90 ? "bg-bad" : "bg-fg/35")} style={{ width: `${pct ?? 0}%` }} />
      </span>
    </span>
  );
}

const pct = (v: number | null | undefined, total: number | null | undefined) => (v != null && total ? (v / total) * 100 : null);

/** One server: its light, name and how full it is now. */
export function ServerRow({ server: s }: { server: ServerCardData }) {
  const last = s.series.at(-1);
  const reachable = serverReachable(s);
  const status = s.isLocal || s.status === "ready" ? "ready" : s.status;
  return (
    <Link href={`/servers/${s.id}`} className={cn("flex flex-col gap-2.5 py-3 transition-colors hover:bg-hover/60", ROW_PAD)}>
      <span className="flex items-center gap-2.5">
        <StatusDot status={status} kind="server" />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-fg">{s.name}</span>
        <span className="flex-none text-xs text-faint">
          {!reachable ? `${statusText(s.status, "server")} · ${s.services} ${s.services === 1 ? "service" : "services"}` : `${s.running}/${s.services} running`}
        </span>
      </span>
      {reachable && s.metricsEnabled && (
        <span className="grid grid-cols-3 gap-4 pl-[18px]">
          <Meter label="CPU" value={last?.cpu ?? null} />
          <Meter label="Memory" value={pct(last?.memory, last?.memoryLimit)} />
          <Meter label="Disk" value={pct(last?.disk, last?.diskTotal)} />
        </span>
      )}
    </Link>
  );
}
