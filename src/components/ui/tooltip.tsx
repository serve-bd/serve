"use client";

import type * as React from "react";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";

export const TooltipProvider = BaseTooltip.Provider;

export function Tooltip({
  content,
  children,
  side = "top",
  delay,
}: {
  content: React.ReactNode;
  children: React.ReactElement<Record<string, unknown>>;
  side?: "top" | "bottom" | "left" | "right";
  /** Milliseconds before it opens; the app default otherwise. 0 for small marks that only make sense with their label. */
  delay?: number;
}) {
  if (!content) return children;
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} delay={delay} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} className="z-[70]">
          <BaseTooltip.Popup className="max-w-xs origin-[var(--transform-origin)] rounded-md border border-line bg-fg px-2 py-1 text-xs text-bg shadow-md transition-[transform,opacity] duration-100 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
