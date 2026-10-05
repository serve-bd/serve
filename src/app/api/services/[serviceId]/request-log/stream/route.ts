import { PassThrough } from "node:stream";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { cannotMessage } from "@/lib/permissions";
import { getSession, requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { runServerIds } from "@/server/deploy/distribution";
import { nameUpstreams, normalizeAccessLine } from "@/server/analytics";
import { proxyPaths } from "@/server/paths";
import { answeredBy, type LogTarget, type RequestRow, requestLogConfig, requestRow, targetFor } from "@/server/request-log";
import { getServer, type ServerCtx } from "@/server/servers/context";
import { serviceInOrg } from "@/server/services/access";

export const dynamic = "force-dynamic";

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

/**
 * The request log as it happens: while a page shows it, the access log of each proxy the service
 * is reached through is followed (tail -F inside the proxy container) and every matching request
 * is sent at once. The worker still saves them every few seconds; the page drops these live rows
 * when the saved ones arrive.
 */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/services/[serviceId]/request-log/stream">) {
  const { serviceId } = await ctx.params;
  const quiet = (message: string) => new Response(`retry: 60000\nevent: problem\ndata: ${JSON.stringify({ message })}\n\n`, { headers: SSE_HEADERS });
  if (!(await getSession())) return quiet("Signed out.");
  const org = await requireOrg();
  if (!org.can("logs.view")) return quiet(cannotMessage("logs.view"));
  let service: typeof schema.service.$inferSelect;
  try {
    service = (await serviceInOrg(serviceId, org.org.id)).service;
  } catch {
    return quiet("This service no longer exists.");
  }
  const [owner] = service.parentServiceId
    ? await db.select({ requestLog: schema.service.requestLog }).from(schema.service).where(eq(schema.service.id, service.parentServiceId))
    : [service];
  const config = requestLogConfig(owner?.requestLog);
  if (!config.enabled) return quiet("The request log is off.");
  const domains = await db.select({ hostname: schema.domain.hostname }).from(schema.domain).where(eq(schema.domain.serviceId, serviceId));
  const target: LogTarget = { serviceId, projectId: service.projectId, orgId: org.org.id, config };
  const targets = new Map(domains.map((d) => [d.hostname.toLowerCase(), target]));
  // Visitors come through the service's own server; an app's extra servers too when DNS points there.
  const serverIds = service.type === "app" ? runServerIds(service.serverId, service.distribution) : [service.serverId];

  const encoder = new TextEncoder();
  const streams: NodeJS.ReadableStream[] = [];
  let closed = false;
  let ping: ReturnType<typeof setInterval> | undefined;
  let flush: ReturnType<typeof setInterval> | undefined;
  let seq = 0;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        clearInterval(flush);
        for (const s of streams) (s as unknown as { destroy?: () => void }).destroy?.();
        try {
          controller.close();
        } catch {}
      };
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          stop();
        }
      };
      _request.signal.addEventListener("abort", stop);

      // Rows wait a moment so a burst goes out as one event (and one lookup of who answered).
      const pending: { ctx: ServerCtx; row: RequestRow }[] = [];
      flush = setInterval(async () => {
        if (!pending.length || closed) return;
        const batch = pending.splice(0);
        const byServer = new Map<ServerCtx, RequestRow[]>();
        for (const p of batch) byServer.set(p.ctx, [...(byServer.get(p.ctx) ?? []), p.row]);
        for (const [server, rows] of byServer) await nameUpstreams(server, rows).catch(() => {});
        const rows = batch.map((p) => p.row);
        const by = await answeredBy(rows.map((r) => ({ upstream: r.upstream ?? null, serverId: r.serverId ?? null }))).catch(() => rows.map(() => null));
        send(
          "requests",
          rows.map((r, i) => ({
            // Negative: never the id of a saved row.
            id: -++seq,
            time: (r.time as Date).toISOString(),
            hostname: r.hostname,
            method: r.method ?? null,
            path: r.path,
            query: r.query ?? false,
            status: r.status,
            durationMs: r.durationMs,
            bytes: r.bytes ?? 0,
            ip: r.ip ?? null,
            userAgent: r.userAgent ?? null,
            referer: r.referer ?? null,
            answeredBy: by[i],
          })),
        );
      }, 500);

      await Promise.all(
        serverIds.map(async (id) => {
          try {
            const server = await getServer(id);
            // tail alone would keep running after the page leaves (Docker does not stop an exec whose
            // connection closed). Here it ends with stdin: the connection closing ends cat, which stops tail.
            const exec = await server.docker.getContainer(server.proxyContainer).exec({
              Cmd: ["sh", "-c", 'tail -n 0 -F "$0" & t=$!; cat >/dev/null; kill $t', `${proxyPaths.logs}/access.log`],
              AttachStdin: true,
              AttachStdout: true,
              AttachStderr: true,
            });
            const raw = (await exec.start({ hijack: true, stdin: true })) as unknown as NodeJS.ReadableStream;
            streams.push(raw);
            if (closed) return stop();
            const out = new PassThrough();
            server.docker.modem.demuxStream(raw, out, new PassThrough());
            let buf = "";
            out.on("data", (chunk: Buffer) => {
              buf += chunk.toString("utf8");
              const lines = buf.split("\n");
              buf = lines.pop() ?? "";
              for (const line of lines) {
                const entry = line && normalizeAccessLine(line);
                if (!entry || !entry.h) continue;
                const t = targetFor(targets, entry.h);
                const row = t && requestRow(entry, t, server.id);
                if (row) pending.push({ ctx: server, row });
              }
            });
          } catch {
            // A server without a running proxy (or unreachable) adds nothing; the saved log still covers it.
          }
        }),
      );
      if (!closed) {
        send("ready", {});
        ping = setInterval(() => send("ping", {}), 15_000);
      }
    },
    cancel() {
      closed = true;
      clearInterval(ping);
      clearInterval(flush);
      for (const s of streams) (s as unknown as { destroy?: () => void }).destroy?.();
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}
