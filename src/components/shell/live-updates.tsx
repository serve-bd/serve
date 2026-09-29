"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useSWRConfig } from "swr";

/**
 * Keeps every open tab current: listens to /api/events (server-sent events) and, when something
 * in this organization changes, refetches client data and re-renders server pages. Batched so a
 * burst of changes (a deploy moving through its steps) costs one refresh.
 */
export function LiveUpdates() {
  const router = useRouter();
  const { mutate } = useSWRConfig();

  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = 0;
    const refresh = () => {
      timer = null;
      last = Date.now();
      void mutate(() => true);
      router.refresh();
    };
    const schedule = () => {
      if (timer) return;
      // At most about one refresh a second, shortly after the first change of a burst.
      timer = setTimeout(refresh, Math.max(300, 1000 - (Date.now() - last)));
    };
    let opened = false;
    const es = new EventSource("/api/events");
    es.addEventListener("change", schedule);
    // After a reconnect, changes may have been missed while offline.
    es.onopen = () => {
      if (opened) schedule();
      opened = true;
    };
    return () => {
      es.close();
      if (timer) clearTimeout(timer);
    };
  }, [router, mutate]);

  return null;
}
