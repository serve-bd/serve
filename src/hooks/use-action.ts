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

/*
 * Open dialogs show the errors of the actions run from them, next to their buttons, instead
 * of a toast. The newest dialog (a confirm over a form) gets them.
 */
export type ErrorSink = { show: (message: string) => void; clear: () => void };
const sinks: ErrorSink[] = [];
export function addErrorSink(sink: ErrorSink) {
  sinks.push(sink);
  return () => {
    const i = sinks.lastIndexOf(sink);
    if (i >= 0) sinks.splice(i, 1);
  };
}
export function showError(message: string, description?: string) {
  const sink = sinks.at(-1);
  if (sink) sink.show(description ? `${message} ${description}` : message);
  else toast.error(message, description);
}

/** Run a server action with pending state, errors (in the open dialog, else a toast) and a router refresh. */
export function useAction<A extends unknown[], T>(action: (...args: A) => Promise<ActionResult<T>>, opts: Options<T> = {}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [refreshing, startRefresh] = React.useTransition();
  // Runs counted in `running` until the refresh after their success has rendered. A count, not a
  // flag: runs of one hook can overlap (several "Create tunnel" clicks) and share one refresh.
  const awaitingRefresh = React.useRef(0);
  const optsRef = useLatest(opts);

  React.useEffect(() => {
    if (!refreshing && awaitingRefresh.current) {
      setRunning(-awaitingRefresh.current);
      awaitingRefresh.current = 0;
    }
  }, [refreshing]);
  // Gone before an action finished: its refresh is not waited for (nothing would ever count it down).
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (awaitingRefresh.current) setRunning(-awaitingRefresh.current);
      awaitingRefresh.current = 0;
    };
  }, []);

  const run = React.useCallback(
    async (...args: A): Promise<T | undefined> => {
      setPending(true);
      setRunning(1);
      sinks.at(-1)?.clear();
      let counted = true;
      try {
        const res = await action(...args);
        if (!res.ok) {
          showError(res.error);
          return undefined;
        }
        const { success, onSuccess, refresh = true } = optsRef.current;
        if (success) toast.success(typeof success === "function" ? success(res.data) : success);
        onSuccess?.(res.data);
        if (refresh && !mounted.current) router.refresh();
        else if (refresh) {
          awaitingRefresh.current += 1;
          counted = false;
          startRefresh(() => router.refresh());
        }
        return res.data;
      } catch (error) {
        showError(error instanceof Error ? error.message : "Something went wrong");
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
