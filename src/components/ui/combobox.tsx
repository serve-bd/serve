"use client";

import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type ComboboxOption = { value: string; label: string; description?: string };

/** Searchable single select for long lists (timezones, regions…). */
export function Combobox({
  value,
  onValueChange,
  options,
  placeholder = "Search…",
  emptyText = "No matches",
  className,
  disabled,
  size = "md",
}: {
  value: string | null;
  onValueChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  emptyText?: string;
  className?: string;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  const selected = options.find((o) => o.value === value) ?? null;
  return (
    <BaseCombobox.Root
      items={options}
      value={selected}
      onValueChange={(item) => item && onValueChange((item as ComboboxOption).value)}
      itemToStringLabel={(item) => (item as ComboboxOption).label}
      isItemEqualToValue={(a, b) => (a as ComboboxOption).value === (b as ComboboxOption).value}
      disabled={disabled}
    >
      <div className={cn("relative w-full min-w-0", className)}>
        <BaseCombobox.Input
          placeholder={placeholder}
          className={cn(
            "w-full min-w-0 rounded-lg border border-line-strong bg-surface pr-9 pl-3 text-sm text-fg shadow-sm outline-none transition-[border-color,box-shadow] placeholder:text-faint hover:bg-surface-2 focus:border-accent focus:ring-3 focus:ring-[var(--ring)]/40 disabled:opacity-60",
            size === "sm" ? "h-8 text-[13px]" : "h-9",
          )}
        />
        <BaseCombobox.Trigger className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-faint hover:text-fg" aria-label="Show options">
          <ChevronsUpDown className="size-3.5" />
        </BaseCombobox.Trigger>
      </div>
      <BaseCombobox.Portal>
        <BaseCombobox.Positioner sideOffset={6} className="z-50 outline-none">
          <BaseCombobox.Popup className="scrollbar-thin max-h-[min(var(--available-height),20rem)] w-[var(--anchor-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-xl border border-line bg-surface/95 p-1 shadow-lg backdrop-blur-xl outline-none transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
            <BaseCombobox.Empty className="px-2 py-1.5 text-sm text-muted empty:hidden">{emptyText}</BaseCombobox.Empty>
            <BaseCombobox.List>
              {(item: ComboboxOption) => (
                <BaseCombobox.Item
                  key={item.value}
                  value={item}
                  className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg-2 outline-none select-none data-[highlighted]:bg-hover data-[highlighted]:text-fg"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{item.label}</span>
                    {item.description && <span className="truncate text-xs text-muted">{item.description}</span>}
                  </span>
                  <BaseCombobox.ItemIndicator className="text-accent">
                    <Check className="size-3.5" />
                  </BaseCombobox.ItemIndicator>
                </BaseCombobox.Item>
              )}
            </BaseCombobox.List>
          </BaseCombobox.Popup>
        </BaseCombobox.Positioner>
      </BaseCombobox.Portal>
    </BaseCombobox.Root>
  );
}
