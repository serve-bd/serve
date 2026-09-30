import { cannotMessage } from "@/lib/permissions";
import { PassThrough } from "node:stream";
import type { NextRequest } from "next/server";
import { requireOrg } from "@/server/auth";
import { serviceInOrg } from "@/server/services/access";
import { LABEL, listServiceContainers } from "@/server/docker/client";
import { serverOf } from "@/server/servers/context";

export const dynamic = "force-dynamic";

/** An RFC3339 timestamp with its fraction padded to nanoseconds, so two of them compare as strings. */
const sortable = (t: string) => t.replace(/(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/, (_, f: string | undefined, zone: string) => `.${(f ?? "").padEnd(9, "0")}${zone}`);

/** Streams container logs as server-sent events. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/services/[serviceId]/logs">) {
  const { serviceId } = await ctx.params;
  const org = await requireOrg();
  if (!org.can("logs.view")) return new Response(cannotMessage("logs.view"), { status: 403 });
  let service;
  try {
    service = (await serviceInOrg(serviceId, org.org.id)).service;
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const tail = Math.min(Math.max(Number(request.nextUrl.searchParams.get("tail") ?? 300), 10), 5000);
  // A reconnect resumes each container after the last line the page has of it (`id:timestamp,…`).
  // Containers it has no line of, like the new ones of a redeploy, start with the usual tail.
  const resume = request.nextUrl.searchParams.get("resume") === "1";
  const since = new Map<string, string>();
  for (const pair of (request.nextUrl.searchParams.get("since") ?? "").split(",")) {
    const i = pair.indexOf(":");
    const t = pair.slice(i + 1);
    if (i > 0 && !Number.isNaN(Date.parse(t))) since.set(pair.slice(0, i), sortable(t));
  }
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

  let ping: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    closed = true;
    clearInterval(ping);
    clearTimeout(retry);
    for (const s of streams) (s as unknown as { destroy?: () => void }).destroy?.();
  };

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Ends the response: the page reconnects and follows the containers running then (a redeploy replaces them).
      const finish = () => {
        if (closed) return;
        stop();
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
      if (!containers.length) {
        // Said once: resumed connections keep quiet while there is still nothing to show.
        if (!resume) send("info", { message: only ? `No container is running for ${only}.` : "No containers are running for this service." });
        retry = setTimeout(finish, 15000);
      }
      const multi = containers.length > 1;
      for (const c of containers) {
        if (closed) break;
        const id = c.Id.slice(0, 12);
        const after = since.get(id);
        const label = c.Labels["com.docker.compose.service"] ?? (multi ? c.Names[0].replace(/^\//, "").split("-").pop() : null);
        try {
          const raw = (await docker.getContainer(c.Id).logs({
            follow: true,
            stdout: true,
            stderr: true,
            ...(after ? { since: Math.floor(Date.parse(after) / 1000) } : { tail }),
            timestamps: true,
          })) as unknown as NodeJS.ReadableStream;
          streams.push(raw);
          // One that ended while attaching this one: the page reconnects anyway.
          if (closed) {
            stop();
            break;
          }
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
              const batch = lines
                .filter(Boolean)
                .map((l) => {
                  const sp = l.indexOf(" ");
                  return { c: id, t: l.slice(0, sp), m: l.slice(sp + 1), s: label, e: isErr };
                })
                // Docker's since is in whole seconds: drop the lines of that second the page already has.
                .filter((l) => !after || sortable(l.t) > after);
              if (batch.length) send("logs", batch);
            });
          };
          forward(out, false);
          forward(err, true);
          raw.on("end", () => {
            if (c.State === "running") send("info", { message: `${label ?? "container"} stopped streaming` });
            // A running or restarting container stopped (a redeploy replaced it, or it crashed): reattach and resume.
            // A stopped one's logs just stay.
            if (c.State === "running" || c.State === "restarting") finish();
          });
        } catch (e) {
          send("info", { message: `Could not attach to ${c.Names[0]}: ${(e as Error).message}` });
        }
      }
      if (closed) return;
      ping = setInterval(() => send("ping", {}), 15000);
      request.signal.addEventListener("abort", finish);
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
