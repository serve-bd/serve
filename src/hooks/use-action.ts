"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/toast";
import type { ActionResult } from "@/server/action";
import { useLatest } from "./use-client";

type Options<T> = {
  success?: string | ((data: T) => string);
  onSuccess?: (data: T) => void;
  /** Refresh server components after success (default true). */
  refresh?: boolean;
};

/** Run a server action with pending state, error toasts and a router refresh. */
export function useAction<A extends unknown[], T>(action: (...args: A) => Promise<ActionResult<T>>, opts: Options<T> = {}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const optsRef = useLatest(opts);

  const run = React.useCallback(
    async (...args: A): Promise<T | undefined> => {
      setPending(true);
      try {
        const res = await action(...args);
        if (!res.ok) {
          toast.error(res.error);
          return undefined;
        }
        const { success, onSuccess, refresh = true } = optsRef.current;
        if (success) toast.success(typeof success === "function" ? success(res.data) : success);
        onSuccess?.(res.data);
        if (refresh) React.startTransition(() => router.refresh());
        return res.data;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Something went wrong");
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [action, router, optsRef],
  );

  return { run, pending };
}
