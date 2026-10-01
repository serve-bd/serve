"use client";

import { LayoutGrid, List, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";

export type View = "grid" | "list" | "canvas";

const options = {
  grid: [LayoutGrid, "Grid"],
  list: [List, "List"],
  canvas: [Workflow, "Canvas"],
} as const;

/** Switches between the views a page offers. */
export function ViewToggle<V extends View>({ view, views, onChange }: { view: V; views: readonly V[]; onChange: (v: V) => void }) {
  return (
    <div role="radiogroup" aria-label="View" className="flex items-center rounded-xl border border-line bg-surface-2 p-0.5">
      {views.map((v) => {
        const [Icon, label] = options[v];
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={view === v}
            aria-label={label}
            title={label}
            onClick={() => onChange(v)}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-[10px] px-2.5 text-[13px] font-medium transition-colors [&_svg]:size-3.5",
              view === v ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
            )}
          >
            <Icon /> <span className="hidden sm:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
