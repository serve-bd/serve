import { sql } from "@/server/db";

/** A change announced by the database triggers (see drizzle/0024_live_events.sql). */
export type LiveEvent = {
  t: "deployment" | "service" | "domain" | "backup" | "task_run" | "tunnel" | "certificate" | "server" | "setting";
  op: string;
  org: string | null;
  project: string | null;
  service: string | null;
};

type Listener = (e: LiveEvent) => void;

const g = globalThis as unknown as { serveEvents?: { listeners: Set<Listener>; started: boolean } };
const hub = (g.serveEvents ??= { listeners: new Set(), started: false });

/** One LISTEN connection per process, shared by every open dashboard tab. */
function start() {
  if (hub.started) return;
  hub.started = true;
  sql
    .listen("serve_events", (payload) => {
      let e: LiveEvent;
      try {
        e = JSON.parse(payload) as LiveEvent;
      } catch {
        return;
      }
      for (const fn of hub.listeners) fn(e);
    })
    .catch(() => {
      hub.started = false;
    });
}

export function subscribe(fn: Listener) {
  start();
  hub.listeners.add(fn);
  return () => {
    hub.listeners.delete(fn);
  };
}
