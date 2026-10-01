"use client";

import type * as React from "react";
import { CircleHelp } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

/** A small "?" next to a title. Opens on hover, and on tap where there is no hover. */
export function HelpTip({ children, label = "More about this" }: { children: React.ReactNode; label?: string }) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        aria-label={label}
        className="inline-flex size-6 flex-none items-center justify-center rounded-md align-middle text-faint transition-colors hover:text-fg-2 focus-visible:text-fg-2 focus-visible:outline-none"
      >
        <CircleHelp className="size-4" />
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="max-w-72 text-[13px] leading-relaxed font-normal text-fg-2">
        {children}
      </PopoverContent>
    </Popover>
  );
}
