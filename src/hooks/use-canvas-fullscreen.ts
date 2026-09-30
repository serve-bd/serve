"use client";

import * as React from "react";
import type { ReactFlowInstance } from "@xyflow/react";

/**
 * Canvas full screen: the canvas covers the whole window. Not the browser's fullscreen, which
 * shows only that element and would hide confirm dialogs, tooltips and toasts. Esc leaves it.
 */
export function useCanvasFullscreen(flow: Pick<ReactFlowInstance, "fitView">) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [full, setFull] = React.useState(false);
  const toggle = React.useCallback(() => setFull((f) => !f), []);

  React.useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      // Esc closes an open dialog first.
      if (e.key !== "Escape" || document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]')) return;
      setFull(false);
    };
    window.addEventListener("keydown", onKey);
    // The page behind must not scroll.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [full]);

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
