"use client";

import Link from "next/link";
import { Check, ChevronsUpDown } from "lucide-react";
import { Menu, MenuContent, MenuLabel, MenuLinkItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/utils";

export type SectionPickerItem = { href: string; label: string; active: boolean; warn?: boolean; danger?: boolean };
export type SectionPickerGroup = { title?: string; items: SectionPickerItem[] };

/** Section navigation on small screens: one button with the current section that opens the full list. */
export function SectionPicker({ groups, className }: { groups: SectionPickerGroup[]; className?: string }) {
  const current = groups.flatMap((g) => g.items).find((i) => i.active);
  const warn = groups.some((g) => g.items.some((i) => i.warn));
  return (
    <Menu>
      <MenuTrigger
        className={cn(
          "flex h-10 w-full items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-3 text-left text-[14px] font-medium text-fg shadow-sm outline-none transition-colors hover:bg-hover focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-[var(--ring)]/40",
          className,
        )}
      >
        <span className="text-[13px] font-normal text-muted">Section</span>
        <span className={cn("min-w-0 flex-1 truncate", current?.danger && "text-bad")}>{current?.label ?? "Choose a section"}</span>
        {warn && !current?.warn && <span className="size-1.5 flex-none rounded-full bg-warn" />}
        <ChevronsUpDown className="size-4 flex-none text-muted" />
      </MenuTrigger>
      <MenuContent align="start" className="max-h-[min(70vh,28rem)] w-[var(--anchor-width)] overflow-y-auto">
        {groups.map((g, gi) => (
          <div key={g.title ?? gi}>
            {gi > 0 && <MenuSeparator />}
            {g.title && <MenuLabel>{g.title}</MenuLabel>}
            {g.items.map((item) => (
              <MenuLinkItem
                key={item.href}
                render={<Link href={item.href} />}
                aria-current={item.active ? "page" : undefined}
                className={cn("h-9 text-[14px]", item.active && "text-fg", item.danger && "text-bad data-[highlighted]:text-bad")}
              >
                <span className="flex-1 truncate">{item.label}</span>
                {item.warn && <span className="size-1.5 rounded-full bg-warn" />}
                {item.active && <Check className="text-accent!" />}
              </MenuLinkItem>
            ))}
          </div>
        ))}
      </MenuContent>
    </Menu>
  );
}
