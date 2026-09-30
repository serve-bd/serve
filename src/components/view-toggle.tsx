"use client";

import { LayoutGrid, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";

export type View = "list" | "canvas";

/** List or canvas. */
export function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <div role="radiogroup" aria-label="View" className="flex items-center rounded-xl border border-line bg-surface-2 p-0.5">
      {(
        [
          ["list", LayoutGrid, "List"],
          ["canvas", Workflow, "Canvas"],
        ] as const
      ).map(([v, Icon, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={view === v}
          onClick={() => onChange(v)}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-[10px] px-2.5 text-[13px] font-medium transition-colors [&_svg]:size-3.5",
            view === v ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
          )}
        >
          <Icon /> {label}
        </button>
      ))}
    </div>
  );
}
