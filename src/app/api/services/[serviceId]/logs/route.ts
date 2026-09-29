import { PassThrough } from "node:stream";
import type { NextRequest } from "next/server";
import { requireOrg } from "@/server/auth";
import { serviceInOrg } from "@/server/services/access";
import { LABEL, listServiceContainers } from "@/server/docker/client";
import { serverOf } from "@/server/servers/context";

export const dynamic = "force-dynamic";

/** Streams container logs as server-sent events. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/services/[serviceId]/logs">) {
  const { serviceId } = await ctx.params;
  const org = await requireOrg();
  let service;
  try {
    service = (await serviceInOrg(serviceId, org.org.id)).service;
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const tail = Math.min(Math.max(Number(request.nextUrl.searchParams.get("tail") ?? 300), 10), 5000);
  let docker;
  let all;
  try {
    docker = (await serverOf(service)).docker;
    all = await listServiceContainers(serviceId, true, docker);
  } catch (e) {
    return new Response(`The server of this service is unreachable: ${(e as Error).message}`, { status: 503 });
  }
  const current = service.type === "app" && service.currentDeploymentId ? all.filter((c) => c.Labels[LABEL.deployment] === service.currentDeploymentId) : all;
  // One compose service only, when the page asks for it.
  const only = request.nextUrl.searchParams.get("container");
  const containers = only ? current.filter((c) => c.Labels["com.docker.compose.service"] === only) : current;

  const encoder = new TextEncoder();
  const streams: NodeJS.ReadableStream[] = [];
  let closed = false;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      if (!containers.length) {
        send("info", { message: only ? `No container is running for ${only}.` : "No containers are running for this service." });
      }
      const multi = containers.length > 1;
      for (const c of containers) {
        const label = c.Labels["com.docker.compose.service"] ?? (multi ? c.Names[0].replace(/^\//, "").split("-").pop() : null);
        try {
          const raw = (await docker.getContainer(c.Id).logs({
            follow: true,
            stdout: true,
            stderr: true,
            tail,
            timestamps: true,
          })) as unknown as NodeJS.ReadableStream;
          streams.push(raw);
          const out = new PassThrough();
          const err = new PassThrough();
          const tty = (await docker.getContainer(c.Id).inspect()).Config.Tty;
          if (tty) raw.pipe(out);
          else docker.modem.demuxStream(raw, out, err);
          const forward = (stream: PassThrough, isErr: boolean) => {
            let buf = "";
            stream.on("data", (chunk: Buffer) => {
              buf += chunk.toString("utf8");
              const lines = buf.split("\n");
              buf = lines.pop() ?? "";
              const batch = lines.filter(Boolean).map((l) => {
                const sp = l.indexOf(" ");
                return { t: l.slice(0, sp), m: l.slice(sp + 1), s: label, e: isErr };
              });
              if (batch.length) send("logs", batch);
            });
          };
          forward(out, false);
          forward(err, true);
          raw.on("end", () => send("info", { message: `${label ?? "container"} stopped streaming` }));
        } catch (e) {
          send("info", { message: `Could not attach to ${c.Names[0]}: ${(e as Error).message}` });
        }
      }
      const ping = setInterval(() => send("ping", {}), 15000);
      request.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(ping);
        for (const s of streams) (s as unknown as { destroy?: () => void }).destroy?.();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      closed = true;
      for (const s of streams) (s as unknown as { destroy?: () => void }).destroy?.();
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
