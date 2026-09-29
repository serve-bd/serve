"use client";

import * as React from "react";
import { useRouter as useNextRouter } from "next/navigation";
import { useRouter as useProgressRouter } from "@bprogress/next/app";

/**
 * Next's router, with the top progress bar on real navigations (push, replace,
 * back, forward). refresh() stays silent: pages poll with it in the background.
 */
export function useRouter() {
  const next = useNextRouter();
  const progress = useProgressRouter();
  return React.useMemo(
    () => ({ ...next, push: progress.push, replace: progress.replace, back: progress.back, forward: progress.forward, refresh: next.refresh }),
    [next, progress],
  );
}
