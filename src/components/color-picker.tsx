"use client";

import { Check } from "lucide-react";
import { projectColors } from "@/components/shell/project-color";
import { cn } from "@/lib/utils";

export function ColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup">
      {Object.entries(projectColors).map(([name, hex]) => (
        <button
          key={name}
          type="button"
          role="radio"
          aria-checked={value === name}
          aria-label={name}
          onClick={() => onChange(name)}
          className={cn(
            "flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-surface transition-transform hover:scale-110",
            value === name && "ring-2 ring-[var(--ring)]",
          )}
          style={{ background: hex }}
        >
          {value === name && <Check className="size-3.5 text-white" strokeWidth={3} />}
        </button>
      ))}
    </div>
  );
}
