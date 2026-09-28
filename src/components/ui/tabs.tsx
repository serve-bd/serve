"use client";

import * as React from "react";
import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { cn } from "@/lib/utils";

export const Tabs = BaseTabs.Root;
export const TabsPanel = BaseTabs.Panel;

export function TabsList({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <BaseTabs.List className={cn("relative z-0 flex w-fit gap-1 rounded-lg border border-line bg-sunken p-1", className)}>
      {children}
      <BaseTabs.Indicator className="absolute top-1/2 left-0 -z-10 h-[var(--active-tab-height)] w-[var(--active-tab-width)] translate-x-[var(--active-tab-left)] -translate-y-1/2 rounded-md bg-surface shadow-sm transition-all duration-200 ease-[var(--ease-out-quint)]" />
    </BaseTabs.List>
  );
}

export function Tab({ className, ...props }: React.ComponentProps<typeof BaseTabs.Tab>) {
  return (
    <BaseTabs.Tab
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium whitespace-nowrap text-muted outline-none transition-colors hover:text-fg data-[selected]:text-fg [&_svg]:size-3.5",
        className as string,
      )}
      {...props}
    />
  );
}
