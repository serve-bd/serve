import type { NextRequest } from "next/server";
import { requireOrg } from "@/server/auth";
import { subscribe, type LiveEvent } from "@/server/events";

export const dynamic = "force-dynamic";

const INSTANCE_WIDE = new Set<LiveEvent["t"]>(["server", "setting"]);
const NO_PROJECT = new Set<LiveEvent["t"]>(["tunnel", "certificate", "server", "setting"]);

/**
 * Server-sent events for live dashboards: which project and service just changed, for this
 * organization and only projects the member can reach. The browser then refetches.
 */
export async function GET(request: NextRequest) {
  const ctx = await requireOrg();
  const reach = ctx.projectIds ? new Set(ctx.projectIds) : null;
  const encoder = new TextEncoder();
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          stop();
        }
      };
      send("retry: 3000\n\n");
      const unsubscribe = subscribe((e) => {
        // Instance-wide rows (servers, settings) carry no organization and reach every member.
        if (e.org !== ctx.org.id && !(e.org === null && INSTANCE_WIDE.has(e.t))) return;
        // Events that name no project (tunnels, certificates, servers) say only that something changed.
        if (reach && e.project && !reach.has(e.project)) return;
        if (reach && !e.project && !NO_PROJECT.has(e.t)) return;
        send(`event: change\ndata: ${JSON.stringify({ t: e.t, project: e.project, service: e.service })}\n\n`);
      });
      // Keeps proxies and tunnels from closing an idle connection.
      const ping = setInterval(() => send(": ping\n\n"), 25_000);
      stop = () => {
        clearInterval(ping);
        unsubscribe();
        try {
          controller.close();
        } catch {}
      };
      request.signal.addEventListener("abort", () => stop());
    },
    cancel() {
      stop();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
