"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useSWRConfig } from "swr";

/**
 * Keeps every open tab current: listens to /api/events (server-sent events) and, when something
 * in this organization changes, refetches client data and re-renders server pages. Batched so a
 * burst of changes (a deploy moving through its steps) costs one refresh.
 */
/** Window event for new requests in a service's request log (detail: the service id). */
export const REQUESTS_EVENT = "serve:requests";

export function LiveUpdates({ scope }: { scope: string }) {
  const router = useRouter();
  const { mutate } = useSWRConfig();

  // `scope` (organization and role): the stream filters by them when it connects, so a switch reconnects.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope only restarts the connection.
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
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let stopped = false;
    const connect = () => {
      let opened = false;
      es = new EventSource("/api/events");
      es.addEventListener("change", (ev) => {
        // New requests in a request log refresh only the lists that show them, not every page.
        try {
          const data = JSON.parse((ev as MessageEvent<string>).data) as { t?: string; service?: string | null };
          if (data.t === "request") {
            window.dispatchEvent(new CustomEvent(REQUESTS_EVENT, { detail: data.service }));
            return;
          }
        } catch {}
        schedule();
      });
      es.onopen = () => {
        // After a reconnect, changes may have been missed while offline.
        if (opened || attempt > 0) schedule();
        opened = true;
        attempt = 0;
      };
      // The browser retries after network errors by itself, but gives up for good on any other
      // answer (a 502 while Serve restarts, a sign-in page): start a new stream then, slower each time.
      es.onerror = () => {
        if (stopped || es?.readyState !== EventSource.CLOSED) return;
        es.close();
        attempt++;
        retry = setTimeout(connect, Math.min(60_000, 2000 * 2 ** Math.min(attempt, 5)));
      };
    };
    connect();
    return () => {
      stopped = true;
      es?.close();
      if (timer) clearTimeout(timer);
      if (retry) clearTimeout(retry);
    };
  }, [router, mutate, scope]);

  return null;
}
