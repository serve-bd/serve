"use client";

import type * as React from "react";
import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { cn } from "@/lib/utils";

export const Menu = BaseMenu.Root;
export const MenuTrigger = BaseMenu.Trigger;

const popupClass =
  "min-w-48 origin-[var(--transform-origin)] rounded-xl border border-line bg-surface/95 p-1 shadow-lg backdrop-blur-xl outline-none transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0";

/** A menu opened by right-clicking (or long-pressing) its trigger; holds the same MenuItems. */
export const ContextMenu = BaseContextMenu.Root;
export const ContextMenuTrigger = BaseContextMenu.Trigger;

export function ContextMenuContent({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <BaseContextMenu.Portal>
      <BaseContextMenu.Positioner className="z-50 outline-none">
        <BaseContextMenu.Popup className={cn(popupClass, className)}>{children}</BaseContextMenu.Popup>
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  );
}

export function MenuContent({
  children,
  align = "end",
  side = "bottom",
  className,
  sideOffset = 6,
}: {
  children: React.ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
  sideOffset?: number;
}) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner align={align} side={side} sideOffset={sideOffset} className="z-50 outline-none">
        <BaseMenu.Popup className={cn(popupClass, className)}>{children}</BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

const itemClass =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-fg-2 outline-none select-none data-[disabled]:opacity-40 data-[highlighted]:bg-hover data-[highlighted]:text-fg [&_svg]:size-4 [&_svg]:text-muted";

export function MenuItem({ className, danger, ...props }: React.ComponentProps<typeof BaseMenu.Item> & { danger?: boolean }) {
  return (
    <BaseMenu.Item className={cn(itemClass, danger && "text-bad data-[highlighted]:bg-bad-soft data-[highlighted]:text-bad [&_svg]:text-bad", className as string)} {...props} />
  );
}

/** A link in a menu. Closes the menu when followed, like other items (Base UI keeps it open by default). */
export function MenuLinkItem({ className, closeOnClick = true, ...props }: React.ComponentProps<typeof BaseMenu.LinkItem>) {
  return <BaseMenu.LinkItem className={cn(itemClass, className as string)} closeOnClick={closeOnClick} {...props} />;
}

export function MenuSeparator() {
  return <BaseMenu.Separator className="-mx-1 my-1 h-px bg-line" />;
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">{children}</div>;
}
