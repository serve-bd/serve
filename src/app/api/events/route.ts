import type { NextRequest } from "next/server";
import { requireOrg } from "@/server/auth";
import { subscribe } from "@/server/events";

export const dynamic = "force-dynamic";

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
        if (e.org !== ctx.org.id) return;
        if (reach && (!e.project || !reach.has(e.project))) return;
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
