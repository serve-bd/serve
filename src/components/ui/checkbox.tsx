"use client";

import type * as React from "react";
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { Check, Minus } from "lucide-react";
import { useNameFromLabel } from "@/lib/name-from-label";
import { cn } from "@/lib/utils";

export function Checkbox({ className, ref, ...props }: React.ComponentProps<typeof BaseCheckbox.Root>) {
  const named = useNameFromLabel(ref, props);
  return (
    <BaseCheckbox.Root
      className={cn(
        "group flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-line-strong bg-surface shadow-sm transition-colors data-[checked]:border-accent data-[checked]:bg-accent data-[indeterminate]:border-accent data-[indeterminate]:bg-accent data-[disabled]:opacity-50",
        className as string,
      )}
      {...props}
      {...named}
    >
      <BaseCheckbox.Indicator className="text-accent-fg data-[unchecked]:hidden">
        {/* Some of a group ticked (indeterminate): a dash, not a tick. */}
        <Check className="size-3 group-data-[indeterminate]:hidden" strokeWidth={3} />
        <Minus className="hidden size-3 group-data-[indeterminate]:block" strokeWidth={3} />
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
}
