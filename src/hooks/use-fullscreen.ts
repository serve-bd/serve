"use client";

import * as React from "react";

/**
 * Full screen for a panel (logs, a terminal, a canvas): it covers the whole window. Not the
 * browser's fullscreen, which shows only that element and would hide confirm dialogs, tooltips and
 * toasts. Esc leaves it.
 */
export function useFullscreen() {
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

  return { full, toggle };
}
