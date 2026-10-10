"use client";

import * as React from "react";
import type { ReactFlowInstance } from "@xyflow/react";
import { useFullscreen } from "@/hooks/use-fullscreen";

/** Canvas full screen: the canvas covers the whole window, and the drawing fits the new size. */
export function useCanvasFullscreen(flow: Pick<ReactFlowInstance, "fitView">) {
  const ref = React.useRef<HTMLDivElement>(null);
  const { full, toggle } = useFullscreen();

  // The canvas changed size: fit the drawing to it again (not on first paint, the canvas does that).
  const was = React.useRef(full);
  React.useEffect(() => {
    if (was.current === full) return;
    was.current = full;
    const id = requestAnimationFrame(() => void flow.fitView({ padding: 0.2, duration: 250, maxZoom: 1 }));
    return () => cancelAnimationFrame(id);
  }, [full, flow]);

  return { ref, full, toggle, className: full ? "fixed inset-0 z-40 bg-sunken" : "relative size-full" };
}
