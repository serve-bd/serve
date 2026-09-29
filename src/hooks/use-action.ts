"use client";

import * as React from "react";
import { useRouter } from "@/hooks/use-router";
import { toast } from "@/components/ui/toast";
import type { ActionResult } from "@/server/action";
import { useLatest } from "./use-client";

type Options<T> = {
  success?: string | ((data: T) => string);
  onSuccess?: (data: T) => void;
  /** Refresh server components after success (default true). */
  refresh?: boolean;
};

/*
 * Actions in flight across the app, including the page refresh that follows
 * them. The confirm dialog uses it to stay open with a spinner until the
 * action it started has finished and the page shows the result.
 */
let running = 0;
const listeners = new Set<() => void>();
function setRunning(delta: number) {
  running = Math.max(0, running + delta);
  for (const l of listeners) l();
}
export function actionsRunning() {
  return running;
}
export function onActionsChange(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Run a server action with pending state, error toasts and a router refresh. */
export function useAction<A extends unknown[], T>(action: (...args: A) => Promise<ActionResult<T>>, opts: Options<T> = {}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [refreshing, startRefresh] = React.useTransition();
  // Counted in `running` until the refresh after success has rendered.
  const awaitingRefresh = React.useRef(false);
  const optsRef = useLatest(opts);

  React.useEffect(() => {
    if (!refreshing && awaitingRefresh.current) {
      awaitingRefresh.current = false;
      setRunning(-1);
    }
  }, [refreshing]);
  React.useEffect(
    () => () => {
      if (awaitingRefresh.current) setRunning(-1);
    },
    [],
  );

  const run = React.useCallback(
    async (...args: A): Promise<T | undefined> => {
      setPending(true);
      setRunning(1);
      let counted = true;
      try {
        const res = await action(...args);
        if (!res.ok) {
          toast.error(res.error);
          return undefined;
        }
        const { success, onSuccess, refresh = true } = optsRef.current;
        if (success) toast.success(typeof success === "function" ? success(res.data) : success);
        onSuccess?.(res.data);
        if (refresh) {
          awaitingRefresh.current = true;
          counted = false;
          startRefresh(() => router.refresh());
        }
        return res.data;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Something went wrong");
        return undefined;
      } finally {
        setPending(false);
        if (counted) setRunning(-1);
      }
    },
    [action, router, optsRef],
  );

  return { run, pending: pending || refreshing };
}
