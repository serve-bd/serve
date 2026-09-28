"use client";

import * as React from "react";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type SelectOption = {
  value: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
};

export function Select({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  className,
  disabled,
  name,
  size = "md",
}: {
  value: string | null;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  name?: string;
  size?: "sm" | "md";
}) {
  const items = options.map((o) => ({ value: o.value, label: o.label }));
  const selected = options.find((o) => o.value === value);
  return (
    <BaseSelect.Root
      items={items}
      value={value}
      onValueChange={(v) => v !== null && onValueChange(v as string)}
      disabled={disabled}
      name={name}
    >
      <BaseSelect.Trigger
        className={cn(
          "flex w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-line-strong bg-surface px-3 text-left text-sm text-fg shadow-sm outline-none transition-[border-color,box-shadow] hover:bg-surface-2 focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-[var(--ring)]/40 data-[disabled]:opacity-60 data-[popup-open]:border-accent",
          size === "sm" ? "h-8 text-[13px]" : "h-9",
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-2 truncate">
          {selected?.icon}
          <BaseSelect.Value className="truncate data-[placeholder]:text-faint" placeholder={placeholder} />
        </span>
        <BaseSelect.Icon className="text-faint">
          <ChevronsUpDown className="size-3.5" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={6} className="z-50 outline-none" alignItemWithTrigger={false}>
          <BaseSelect.Popup className="max-h-[min(var(--available-height),22rem)] min-w-[var(--anchor-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-xl border border-line bg-surface/95 p-1 shadow-lg backdrop-blur-xl outline-none transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 scrollbar-thin">
            <BaseSelect.List>
              {options.map((o) => (
                <BaseSelect.Item
                  key={o.value}
                  value={o.value}
                  disabled={o.disabled}
                  className="group flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg-2 outline-none select-none data-[disabled]:opacity-40 data-[highlighted]:bg-hover data-[highlighted]:text-fg"
                >
                  {o.icon}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <BaseSelect.ItemText className="truncate">{o.label}</BaseSelect.ItemText>
                    {o.description && <span className="truncate text-xs text-muted">{o.description}</span>}
                  </span>
                  <BaseSelect.ItemIndicator className="text-accent">
                    <Check className="size-3.5" />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
