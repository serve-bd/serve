import type Docker from "dockerode";
import type { schema } from "@/server/db";
import { serviceHasHostAccess } from "@/server/security";
import { execCommand, execTargets, pickContainer } from "./exec";
import { type getSession, subscribe } from "./terminal";

type TerminalSession = NonNullable<ReturnType<typeof getSession>>;

/*
 * What the dashboard console and the API (serve exec) share: who may open a shell where, which
 * container a command runs in, and how a one-off command's output is streamed back.
 */

type Service = typeof schema.service.$inferSelect;

export const HOST_SHELL = "This service has host-level access: only admins of the Root organization can run commands in it.";

/** Host mounts or privileged: a shell there is close to a shell on the host. */
export const hostShellRefused = (service: Pick<Service, "runtime" | "compose">, isInstanceAdmin: boolean) => serviceHasHostAccess(service) && !isInstanceAdmin;

/** The number at the end of a container name (web-1a2b3c-2, shop-web-2): its replica. */
export const replicaOf = (name: string) => {
  const m = /-(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
};

/**
 * The container to run in: `target` (compose service, container name or id prefix) as the
 * console picks it, and with `replica` the one with that number (1 is the first).
 */
export async function pickConsoleContainer(service: Service, opts: { target?: string | null; replica?: number | null }) {
  if (opts.replica === undefined || opts.replica === null) return pickContainer(service, opts.target);
  const all = await execTargets(service);
  if (!all.length) throw new Error("No running container. Deploy or start the service first.");
  const targets = opts.target ? all.filter((t) => t.composeService === opts.target || t.name === opts.target || t.id.startsWith(opts.target!)) : all;
  if (!targets.length) throw new Error(`No running container matches "${opts.target}".`);
  const match = targets.find((t) => replicaOf(t.name) === opts.replica);
  if (match) return match;
  // A single container (a database) is replica 1 whatever its name.
  if (opts.replica === 1 && targets.length === 1) return targets[0];
  const running = targets
    .map((t) => replicaOf(t.name))
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  throw new Error(`There is no running replica ${opts.replica}.${running.length ? ` Running: ${[...new Set(running)].join(", ")}.` : ""}`);
}

/** Runs a one-off command and streams its output as plain text. The last line is "\u0000<exit code>". */
export function execResponse(container: { id: string; docker: Docker }, command: string, signal: AbortSignal) {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  signal.addEventListener("abort", () => abort.abort());
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          abort.abort();
        }
      };
      try {
        const result = await execCommand(container.id, command, { onData: push, signal: abort.signal, timeoutSeconds: 900, docker: container.docker });
        push(`\n\u0000${result.exitCode}`);
      } catch (e) {
        push(`${(e as Error).message}\n\u00001`);
      }
      try {
        controller.close();
      } catch {}
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" } });
}

/** Terminal output as Server-Sent Events, from after `since` (a reconnect replays what it missed). */
export function terminalEvents(session: TerminalSession, since: number, signal: AbortSignal) {
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
      signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", connection: "keep-alive" },
  });
}
