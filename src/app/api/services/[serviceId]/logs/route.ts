import { cannotMessage } from "@/lib/permissions";
import { PassThrough } from "node:stream";
import type { NextRequest } from "next/server";
import { getSession, requireOrg } from "@/server/auth";
import { serviceInOrg } from "@/server/services/access";
import { LABEL, listServiceContainers } from "@/server/docker/client";
import { getServer, serverOf } from "@/server/servers/context";
import { replicaInstances } from "@/server/services/types";
import type Docker from "dockerode";
import { inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { runServerIds } from "@/server/deploy/distribution";

const serverNames = async (ids: string[]) => (await db.select({ name: schema.server.name }).from(schema.server).where(inArray(schema.server.id, ids))).map((s) => s.name);

export const dynamic = "force-dynamic";

/** An RFC3339 timestamp with its fraction padded to nanoseconds, so two of them compare as strings. */
const sortable = (t: string) => t.replace(/(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/, (_, f: string | undefined, zone: string) => `.${(f ?? "").padEnd(9, "0")}${zone}`);

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

/**
 * Why no logs can stream, as one event the page shows (a browser's EventSource cannot read the
 * body of an error response, so the page would only see a failed connection and retry blindly).
 */
function problem(message: string, retryMs = 10_000) {
  return new Response(`retry: ${retryMs}\nevent: problem\ndata: ${JSON.stringify({ message })}\n\n`, { headers: SSE_HEADERS });
}

/** Streams container logs as server-sent events. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/services/[serviceId]/logs">) {
  const { serviceId } = await ctx.params;
  // Without a session requireOrg redirects to the sign-in page, which a log stream cannot follow.
  if (!(await getSession())) return problem("You are signed out. Sign in again to see the logs.", 60_000);
  const org = await requireOrg();
  if (!org.can("logs.view")) return problem(cannotMessage("logs.view"), 60_000);
  let service;
  try {
    service = (await serviceInOrg(serviceId, org.org.id)).service;
  } catch {
    return problem("This service no longer exists.", 60_000);
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
  // A database's tabs: "database", "pooler" or "replica-<id>" (a replica may run on another server).
  const only = request.nextUrl.searchParams.get("container");
  const replica = service.type === "database" && only?.startsWith("replica-") ? replicaInstances(service).find((r) => `replica-${r.id}` === only) : undefined;
  // An app on several servers: the replicas of every server, each named "<server> · <number>".
  const runOn = service.type === "app" ? runServerIds(service.serverId, service.distribution) : [service.serverId];
  const multiServer = runOn.length > 1;
  type Found = Awaited<ReturnType<typeof listServiceContainers>>[number] & { docker: Docker; server: { id: string; name: string } };
  let all: Found[] = [];
  const unreachable: string[] = [];
  try {
    if (multiServer) {
      const found = await Promise.all(
        runOn.map(async (id, i) => {
          try {
            const server = await getServer(id);
            const list = await listServiceContainers(serviceId, true, server.docker);
            // Each server runs the current version once it switched; one whose deploy failed keeps an older one.
            const app = list.filter((c) => c.Labels[LABEL.kind] === "app" || !c.Labels[LABEL.kind]);
            const current = app.filter((c) => c.Labels[LABEL.deployment] === service.currentDeploymentId);
            return (i === 0 || current.length ? current : app.filter((c) => c.State === "running")).map((c) => ({
              ...c,
              docker: server.docker,
              server: { id, name: server.name },
            }));
          } catch {
            unreachable.push(id);
            return [];
          }
        }),
      );
      all = found.flat();
      if (unreachable.length === runOn.length) throw new Error("no server answered");
    } else {
      const server = replica ? await getServer(replica.serverId) : await serverOf(service);
      const list = await listServiceContainers(serviceId, true, server.docker);
      const current = service.type === "app" && service.currentDeploymentId ? list.filter((c) => c.Labels[LABEL.deployment] === service.currentDeploymentId) : list;
      all = current.map((c) => ({ ...c, docker: server.docker, server: { id: server.id, name: server.name } }));
    }
  } catch (e) {
    return problem(`The server of this service cannot be reached: ${(e as Error).message}`);
  }
  // One compose service, one app replica (the number its container name ends with, with its server
  // when there are several), or one of a database's containers by kind, when the page asks for it.
  const replicaOf = (c: Found) => c.Names[0]?.replace(/^\//, "").split("-").pop();
  const keyOf = (c: Found) => (multiServer ? `${c.server.id}:${replicaOf(c)}` : replicaOf(c));
  const containers = only
    ? all.filter((c) =>
        service.type === "database" ? c.Labels[LABEL.kind] === only : (c.Labels["com.docker.compose.service"] ?? (service.type === "app" ? keyOf(c) : undefined)) === only,
      )
    : all;

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
      if (unreachable.length && !resume) {
        const names = await serverNames(unreachable);
        send("info", { message: `Not showing ${names.join(", ")}: the server cannot be reached.` });
      }
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
        const docker = c.docker;
        const label = c.Labels["com.docker.compose.service"] ?? (multiServer ? `${c.server.name} · ${replicaOf(c)}` : multi ? replicaOf(c) : null);
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

  return new Response(body, { headers: SSE_HEADERS });
}
