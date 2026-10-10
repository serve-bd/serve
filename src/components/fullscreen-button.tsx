"use client";

import * as React from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * Full screen button of a dark panel (logs, a terminal). Not shown inside a dialog: a dialog is
 * already in front of the page, and a panel there cannot cover the window.
 */
export function FullscreenButton({ full, onClick }: { full: boolean; onClick: () => void }) {
  const ref = React.useRef<HTMLButtonElement>(null);
  const [inDialog, setInDialog] = React.useState(false);
  React.useLayoutEffect(() => {
    setInDialog(!!ref.current?.closest('[role="dialog"], [role="alertdialog"]'));
  }, []);
  if (inDialog) return null;
  const label = full ? "Exit full screen" : "Full screen";
  return (
    <Tooltip content={full ? "Exit full screen (Esc)" : "Full screen"}>
      <button ref={ref} type="button" onClick={onClick} aria-label={label} className="rounded-md p-1.5 text-white/40 hover:bg-white/[0.08] hover:text-white/80">
        {full ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
      </button>
    </Tooltip>
  );
}
