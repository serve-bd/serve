"use client";

import type * as React from "react";
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export function Checkbox({ className, ...props }: React.ComponentProps<typeof BaseCheckbox.Root>) {
  return (
    <BaseCheckbox.Root
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-line-strong bg-surface shadow-sm transition-colors data-[checked]:border-accent data-[checked]:bg-accent data-[disabled]:opacity-50",
        className as string,
      )}
      {...props}
    >
      <BaseCheckbox.Indicator className="text-accent-fg data-[unchecked]:hidden">
        <Check className="size-3" strokeWidth={3} />
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
}
