"use client";

import * as React from "react";
import { useTheme as useNextTheme } from "next-themes";

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

/** The theme on screen and a toggle between light and dark (next-themes underneath). */
export function useTheme() {
  const { resolvedTheme, setTheme } = useNextTheme();
  const theme = (resolvedTheme === "light" ? "light" : "dark") as "light" | "dark";
  const toggle = React.useCallback(() => setTheme(theme === "dark" ? "light" : "dark"), [theme, setTheme]);
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
