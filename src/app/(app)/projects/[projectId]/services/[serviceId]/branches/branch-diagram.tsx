"use client";

import Link from "next/link";
import { Box, Database, GitBranch } from "lucide-react";
import { cn, formatBytes } from "@/lib/utils";

export type DiagramBranch = {
  id: string;
  name: string;
  status: "creating" | "ready" | "resetting" | "failed" | "deleting";
  sizeBytes: number | null;
  scrubbed: boolean;
  sourceBranchId: string | null;
  preview: { id: string; pr: number | null } | null;
  consumers: { id: string; name: string; status: string; previewPr: number | null; keys: string[] }[];
};

const NODE_W = 236;
const NODE_H = 68;
const ROW = 84;
const COL = [0, 340, 690];
const PAD = 40;
/** A branch of a branch sits this much to the right of its source, like a tree. */
const INDENT = 28;

const busy = (s: DiagramBranch["status"]) => s === "creating" || s === "resetting" || s === "deleting";

function Dot({ tone }: { tone: "ok" | "busy" | "bad" | "idle" }) {
  return (
    <span
      className={cn(
        "absolute top-3.5 right-3.5 size-2 rounded-full",
        tone === "ok" && "bg-ok",
        tone === "busy" && "animate-pulse bg-info",
        tone === "bad" && "bg-bad",
        tone === "idle" && "bg-idle",
      )}
    />
  );
}

function Node({
  x,
  y,
  icon,
  title,
  subtitle,
  tone,
  highlight,
  progress,
  href,
}: {
  x: number;
  y: number;
  icon: React.ReactNode;
  title: string;
  subtitle: React.ReactNode;
  tone: "ok" | "busy" | "bad" | "idle";
  highlight?: boolean;
  progress?: boolean;
  href?: string;
}) {
  const body = (
    <>
      <span className="flex size-9 flex-none items-center justify-center rounded-[10px] border border-line bg-surface-2 text-fg-2 [&_svg]:size-4">{icon}</span>
      <span className="flex min-w-0 flex-col gap-0.5 pr-4">
        <span className="truncate text-[14px] font-semibold text-fg">{title}</span>
        <span className="truncate text-[12px] text-muted">{subtitle}</span>
      </span>
      <Dot tone={tone} />
      {progress && (
        <span className="absolute inset-x-4 bottom-1.5 h-0.5 overflow-hidden rounded-full bg-info/20">
          <span className="block h-full w-1/3 animate-[serve-progress_1.4s_ease-in-out_infinite] rounded-full bg-info" />
        </span>
      )}
    </>
  );
  const className = cn(
    "absolute flex items-center gap-3 rounded-xl border bg-surface px-3.5 shadow-sm transition-colors",
    highlight ? "border-info/60" : "border-line",
    href && "hover:border-line-strong",
  );
  const style = { left: x, top: y, width: NODE_W, height: NODE_H };
  return href ? (
    <Link href={href} className={className} style={style}>
      {body}
    </Link>
  ) : (
    <div className={className} style={style}>
      {body}
    </div>
  );
}

/** Main database on the left, its branches in the middle, the services that use each branch on the right. */
export function BranchDiagram({
  projectId,
  serviceName,
  engineLabel,
  running,
  branches,
}: {
  projectId: string;
  serviceName: string;
  engineLabel: string;
  running: boolean;
  branches: DiagramBranch[];
}) {
  // Tree order: each branch right after the branch it copies. Copies of a missing branch start a tree.
  const ordered: { b: DiagramBranch; depth: number }[] = [];
  const visit = (b: DiagramBranch, depth: number) => {
    if (ordered.some((o) => o.b.id === b.id)) return;
    ordered.push({ b, depth });
    for (const c of branches) if (c.sourceBranchId === b.id) visit(c, depth + 1);
  };
  for (const b of branches) if (!b.sourceBranchId || !branches.some((x) => x.id === b.sourceBranchId)) visit(b, 0);
  for (const b of branches) visit(b, 0);
  // Each branch takes as many rows as the services that use it, at least one.
  let row = 0;
  const placed = ordered.map(({ b, depth }) => {
    const rows = Math.max(1, b.consumers.length);
    const top = row;
    row += rows;
    return { b, top, rows, dx: Math.min(depth, 3) * INDENT };
  });
  const totalRows = Math.max(1, row);
  const height = PAD * 2 + (totalRows - 1) * ROW + NODE_H;
  const width = PAD * 2 + COL[2] + NODE_W;
  const yOf = (r: number) => PAD + r * ROW;
  const mainY = PAD + ((totalRows - 1) * ROW) / 2;
  const anyBusy = branches.some((b) => busy(b.status));

  return (
    <div className="relative">
      <div className="scrollbar-thin overflow-x-auto">
        <div
          className="relative mx-auto [background-image:radial-gradient(var(--line-strong)_1px,transparent_1px)] [background-size:18px_18px]"
          style={{ width, height: height + (anyBusy ? 28 : 0) }}
        >
          <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden>
            <style>{"@keyframes serve-dash{to{stroke-dashoffset:-24}}@keyframes serve-progress{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}"}</style>
            {placed.map(({ b, top, rows, dx }) => {
              const by = yOf(top + (rows - 1) / 2) + NODE_H / 2;
              const x1 = PAD + COL[0] + NODE_W;
              const x2 = PAD + COL[1];
              const my = mainY + NODE_H / 2;
              const mid = (x1 + x2) / 2;
              const copying = b.status === "creating" || b.status === "resetting";
              // A copy of another branch: an elbow from under that branch's icon into this one.
              const from = placed.find((p) => p.b.id === b.sourceBranchId);
              const fx = from ? x2 + from.dx + 18 : 0;
              const fy = from ? yOf(from.top + (from.rows - 1) / 2) + NODE_H : 0;
              return (
                <g key={b.id}>
                  <path
                    d={from ? `M ${fx} ${fy} V ${by - 8} Q ${fx} ${by}, ${fx + 8} ${by} H ${x2 + dx}` : `M ${x1} ${my} C ${mid} ${my}, ${mid} ${by}, ${x2} ${by}`}
                    fill="none"
                    strokeWidth={1.5}
                    className={copying ? "stroke-info" : b.status === "failed" ? "stroke-bad/60" : "stroke-line-strong"}
                    strokeDasharray={copying ? "6 6" : undefined}
                    style={copying ? { animation: "serve-dash 0.8s linear infinite" } : undefined}
                  />
                  {b.consumers.map((c, i) => {
                    const cy = yOf(top + i) + NODE_H / 2;
                    const a = PAD + COL[1] + NODE_W + dx;
                    const z = PAD + COL[2];
                    const m = (a + z) / 2;
                    return <path key={c.id} d={`M ${a} ${by} C ${m} ${by}, ${m} ${cy}, ${z} ${cy}`} fill="none" strokeWidth={1.5} className="stroke-line-strong" />;
                  })}
                </g>
              );
            })}
          </svg>

          <span className="absolute font-mono text-[11px] text-faint" style={{ left: PAD + 2, top: mainY - 20 }}>
            main
          </span>
          <Node x={PAD + COL[0]} y={mainY} icon={<Database />} title={serviceName} subtitle={`${engineLabel} · main data`} tone={running ? "ok" : "idle"} highlight />

          {placed.map(({ b, top, rows, dx }) => {
            const y = yOf(top + (rows - 1) / 2);
            const source = branches.find((x) => x.id === b.sourceBranchId);
            const kind = b.preview ? `preview #${b.preview.pr}` : source ? `from ${source.name}` : "branch";
            const subtitle =
              b.status === "creating" || b.status === "resetting" ? (
                <span className="text-info">Copying data…</span>
              ) : b.status === "deleting" ? (
                "Deleting…"
              ) : b.status === "failed" ? (
                <span className="text-bad">Copy failed</span>
              ) : b.scrubbed ? (
                b.preview || source ? (
                  `${kind} · data hidden`
                ) : (
                  "personal data hidden"
                )
              ) : (
                `${kind}${b.sizeBytes !== null ? ` · ${formatBytes(b.sizeBytes)}` : ""}`
              );
            return (
              <div key={b.id}>
                <Node
                  x={PAD + COL[1] + dx}
                  y={y}
                  icon={<GitBranch />}
                  title={b.name}
                  subtitle={subtitle}
                  tone={busy(b.status) ? "busy" : b.status === "failed" ? "bad" : "ok"}
                  progress={b.status === "creating" || b.status === "resetting"}
                />
                {b.consumers.map((c, i) => {
                  const cy = yOf(top + i);
                  const label = c.keys.length > 1 ? `${c.keys[0]} +${c.keys.length - 1}` : c.keys[0];
                  const a = PAD + COL[1] + NODE_W + dx;
                  const z = PAD + COL[2];
                  const pillY = (y + cy) / 2 + NODE_H / 2;
                  return (
                    <div key={c.id}>
                      <span
                        className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-line bg-surface-2 px-2.5 py-0.5 font-mono text-[10.5px] text-muted"
                        style={{ left: (a + z) / 2, top: pillY }}
                        title={c.keys.join(", ")}
                      >
                        {label}
                      </span>
                      <Node
                        x={z}
                        y={cy}
                        icon={<Box />}
                        title={c.name}
                        subtitle={c.previewPr ? `Preview #${c.previewPr}` : c.status}
                        tone={
                          c.status === "running"
                            ? "ok"
                            : c.status === "failed" || c.status === "crashed"
                              ? "bad"
                              : ["building", "deploying", "restarting"].includes(c.status)
                                ? "busy"
                                : "idle"
                        }
                        href={`/projects/${projectId}/services/${c.id}`}
                      />
                    </div>
                  );
                })}
              </div>
            );
          })}

          {anyBusy && (
            <p className="absolute inset-x-0 text-center text-xs text-muted" style={{ top: height - 6 }}>
              The main database keeps serving while the copy runs.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
