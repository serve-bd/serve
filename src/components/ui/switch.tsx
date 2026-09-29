"use client";

import type * as React from "react";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";

export function Switch({ className, ...props }: React.ComponentProps<typeof BaseSwitch.Root>) {
  return (
    <BaseSwitch.Root
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-line-strong bg-sunken p-0.5 transition-colors duration-200 data-[checked]:border-accent data-[checked]:bg-accent data-[disabled]:opacity-50",
        className as string,
      )}
      {...props}
    >
      <BaseSwitch.Thumb className="block size-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 ease-[var(--ease-out-quint)] data-[checked]:translate-x-4" />
    </BaseSwitch.Root>
  );
}

/** Row with a title, description and a switch on the right. */
export function SwitchRow({
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
  name,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  name?: string;
}) {
  return (
    <label className="flex items-start justify-between gap-6 py-1">
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-fg">{title}</span>
        {description && <span className="text-xs leading-relaxed text-muted">{description}</span>}
      </span>
      <Switch name={name} checked={checked} onCheckedChange={(v) => onCheckedChange?.(v)} disabled={disabled} className="mt-0.5" />
    </label>
  );
}
