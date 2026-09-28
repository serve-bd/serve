"use client";

import * as React from "react";

function subscribeNow(cb: () => void) {
  const t = setInterval(cb, 30_000);
  return () => clearInterval(t);
}

/** Current time bucketed to 30s; null during SSR and hydration. */
export function useNow(): number | null {
  return React.useSyncExternalStore(
    subscribeNow,
    () => Math.floor(Date.now() / 30_000) * 30_000,
    () => null,
  );
}

function subscribeTheme(cb: () => void) {
  const observer = new MutationObserver(cb);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

export function useTheme() {
  const theme = React.useSyncExternalStore(
    subscribeTheme,
    () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
    () => "dark",
  ) as "light" | "dark";
  const toggle = React.useCallback(() => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("serve-theme", next);
    } catch {}
  }, []);
  return { theme, toggle };
}

/** Value that updates after `delay` ms without changes. */
export function useDebounced<T>(value: T, delay = 400): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/** Keeps a ref pointing at the latest value without writing during render. */
export function useLatest<T>(value: T) {
  const ref = React.useRef(value);
  React.useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
