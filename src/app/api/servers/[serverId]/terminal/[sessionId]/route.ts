import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireInstanceAdmin } from "@/server/auth";
import { closeSession, getSession, hostScope, resizeSession, subscribe, writeSession } from "@/server/services/terminal";

export const dynamic = "force-dynamic";

type Ctx = RouteContext<"/api/servers/[serverId]/terminal/[sessionId]">;

async function load(ctx: Ctx) {
  const { serverId, sessionId } = await ctx.params;
  const admin = await requireInstanceAdmin().catch(() => null);
  if (!admin) return null;
  const session = getSession(sessionId, admin.user.id);
  return session && session.scope === hostScope(serverId) ? session : null;
}

/** Terminal output as Server-Sent Events. `?since=<seq>` replays missed output after a reconnect. */
export async function GET(request: NextRequest, ctx: Ctx) {
  const session = await load(ctx);
  if (!session) return NextResponse.json({ error: "Session ended" }, { status: 404 });
  // EventSource sends Last-Event-ID when it reconnects on its own.
  const since = Number(request.headers.get("last-event-id") ?? request.nextUrl.searchParams.get("since") ?? 0) || 0;
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const ping = setInterval(() => send(": ping\n\n"), 15_000);
      const unsubscribe = subscribe(session, since, (event) => {
        if (event.type === "data") send(`id: ${event.seq}\ndata: ${event.data.toString("base64")}\n\n`);
        else {
          send(`event: exit\ndata: ${JSON.stringify({ code: event.code })}\n\n`);
          cleanup();
          try {
            controller.close();
          } catch {}
        }
      });
      cleanup = () => {
        clearInterval(ping);
        unsubscribe();
      };
      request.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", connection: "keep-alive" },
  });
}

const inputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max(64 * 1024) }),
  z.object({ type: z.literal("resize"), cols: z.number(), rows: z.number() }),
]);

/** Keystrokes and window size changes. */
export async function POST(request: NextRequest, ctx: Ctx) {
  const session = await load(ctx);
  if (!session) return NextResponse.json({ error: "Session ended" }, { status: 404 });
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  if (parsed.data.type === "input") writeSession(session, parsed.data.data);
  else await resizeSession(session, parsed.data.cols, parsed.data.rows);
  return new Response(null, { status: 204 });
}

export async function DELETE(_request: NextRequest, ctx: Ctx) {
  const session = await load(ctx);
  if (session) closeSession(session.id);
  return new Response(null, { status: 204 });
}
