import { z } from "zod";
import type { ApiAuth } from "@/server/api-auth";
import { loadService } from "../data";
import { ApiError, type ApiRoute, route } from "../router";

/*
 * The console over the API (serve exec, serve ssh): a command in a service's container, or a
 * shell with a TTY in it or on a server. The same checks as the dashboard's console and server
 * terminal, with the token's permissions: console.access, the service's project, and for a
 * service with host-level access, an admin of the Root organization.
 *
 * A shell is a session in this process, like in the dashboard: its output arrives as Server-Sent
 * Events and keystrokes as small POSTs (not counted against the rate limit).
 */

const size = { cols: z.number().int().min(10).max(500).default(80), rows: z.number().int().min(4).max(200).default(24) };
const pick = { target: z.string().max(200).nullable().optional(), replica: z.number().int().min(1).nullable().optional() };

const input = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max(64 * 1024) }),
  z.object({ type: z.literal("resize"), cols: z.number(), rows: z.number() }),
]);

const since = (request: Request, query: { since?: number }) => Number(request.headers.get("last-event-id") ?? query.since ?? 0) || 0;

async function orgContext() {
  const { requireOrg } = await import("@/server/auth");
  return requireOrg();
}

/** The service, when the token may open a console in it (its project; host access needs a Root admin). */
async function consoleService(auth: ApiAuth, serviceId: string) {
  const { service } = await loadService(auth, serviceId);
  const { HOST_SHELL, hostShellRefused } = await import("@/server/services/console");
  if (hostShellRefused(service, (await orgContext()).isInstanceAdmin)) throw new ApiError(403, HOST_SHELL);
  return service;
}

async function container(service: Awaited<ReturnType<typeof consoleService>>, body: { target?: string | null; replica?: number | null }) {
  const { pickConsoleContainer } = await import("@/server/services/console");
  try {
    return await pickConsoleContainer(service, body);
  } catch (e) {
    throw new ApiError(409, (e as Error).message);
  }
}

/** An open shell of this token's user in the service; checked on every call, access can change while it is open. */
async function serviceSession(auth: ApiAuth, serviceId: string, sessionId: string) {
  const { getSession, closeSession } = await import("@/server/services/terminal");
  const session = getSession(sessionId, auth.userId);
  if (!session || session.scope !== `service:${serviceId}`) throw new ApiError(404, "Session ended");
  try {
    await loadService(auth, serviceId);
  } catch {
    closeSession(session.id);
    throw new ApiError(404, "Session ended");
  }
  return session;
}

/** Who may open a shell on a server: the dashboard's rule, admins who manage it. */
async function managedServer(serverId: string) {
  const { getServerRow } = await import("@/server/servers/context");
  const { canManageServer } = await import("@/server/servers/access");
  const ctx = await orgContext();
  const row = await getServerRow(serverId).catch(() => null);
  if (!row) throw new ApiError(404, "Server not found.");
  if (!canManageServer(ctx, row)) throw new ApiError(403, "Only admins who manage this server can open a shell on it.");
  return { ctx, row };
}

async function serverSession(auth: ApiAuth, serverId: string, sessionId: string) {
  const { getSession, hostScope, closeSession } = await import("@/server/services/terminal");
  const session = getSession(sessionId, auth.userId);
  if (!session || session.scope !== hostScope(serverId)) throw new ApiError(404, "Session ended");
  try {
    await managedServer(serverId);
  } catch {
    closeSession(session.id);
    throw new ApiError(404, "Session ended");
  }
  return session;
}

async function sessionInput(session: Parameters<typeof import("@/server/services/terminal").writeSession>[0], body: z.output<typeof input>) {
  const { writeSession, resizeSession } = await import("@/server/services/terminal");
  if (body.type === "input") writeSession(session, body.data);
  else await resizeSession(session, body.cols, body.rows);
  return new Response(null, { status: 204 });
}

/** Routes of one kind of terminal: GET events, POST input, DELETE. */
function sessionRoutes(base: string, tag: string, needs: ApiRoute["needs"], load: (auth: ApiAuth, id: string, sessionId: string) => ReturnType<typeof serviceSession>, id: string) {
  return [
    route({
      method: "GET",
      path: `${base}/terminal/{sessionId}`,
      tag,
      summary: "Output of an open shell",
      description:
        'Server-Sent Events: each "data" is base64 output with its number as the event id; an "exit" event ({"code": n}) ends it. since (or Last-Event-ID) replays output after that number, after a reconnect. A shell nobody listens to closes after a minute.',
      needs,
      produces: "text/event-stream",
      query: z.object({ since: z.coerce.number().int().min(0).optional() }),
      handler: async ({ auth, params, query, request }) => {
        const session = await load(auth, params[id], params.sessionId);
        const { terminalEvents } = await import("@/server/services/console");
        return terminalEvents(session, since(request, query), request.signal);
      },
    }),
    route({
      method: "POST",
      path: `${base}/terminal/{sessionId}`,
      tag,
      summary: "Type into an open shell, or resize it",
      description: '{"type": "input", "data": "ls\\r"} or {"type": "resize", "cols": 120, "rows": 40}. Answers 204. Not counted against the rate limit.',
      needs,
      unmetered: true,
      status: 204,
      body: input,
      handler: async ({ auth, params, body }) => sessionInput(await load(auth, params[id], params.sessionId), body),
    }),
    route({
      method: "DELETE",
      path: `${base}/terminal/{sessionId}`,
      tag,
      summary: "Close an open shell",
      needs,
      status: 204,
      handler: async ({ auth, params }) => {
        const session = await load(auth, params[id], params.sessionId).catch(() => null);
        if (session) (await import("@/server/services/terminal")).closeSession(session.id);
        return new Response(null, { status: 204 });
      },
    }),
  ];
}

export const consoleRoutes: ApiRoute[] = [
  route({
    method: "GET",
    path: "/services/{serviceId}/exec",
    tag: "Console",
    summary: "Containers a command can run in",
    description: "The running containers of the service (of its current deployment for an app), by name and compose service.",
    needs: ["console.access"],
    handler: async ({ auth, params }) => {
      const service = await consoleService(auth, params.serviceId);
      const { execTargets } = await import("@/server/services/exec");
      const { replicaOf } = await import("@/server/services/console");
      try {
        const targets = await execTargets(service);
        return { containers: targets.map((t) => ({ id: t.id.slice(0, 12), name: t.name, composeService: t.composeService, replica: replicaOf(t.name) })) };
      } catch (e) {
        throw new ApiError(503, `The server of this service is unreachable: ${(e as Error).message}`);
      }
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/exec",
    tag: "Console",
    summary: "Run a command in a container",
    description:
      "Runs `sh -c command` in a running container of the service (the first one, or target: a compose service, container name or id; replica: its number) and streams the output as plain text, standard output and errors together. The last line is a NUL character followed by the exit code. It stops after 15 minutes. Services with host-level access need an admin of the Root organization, as in the dashboard.",
    needs: ["console.access"],
    produces: "text/plain",
    body: z.object({ command: z.string().trim().min(1, "Enter a command").max(4000), ...pick }),
    handler: async ({ auth, params, body, request }) => {
      const service = await consoleService(auth, params.serviceId);
      const target = await container(service, body);
      const { logActivity } = await import("@/server/activity");
      await logActivity({
        userId: auth.userId,
        projectId: service.projectId,
        action: "service.exec",
        targetType: "service",
        targetId: service.id,
        message: `Ran \`${body.command.slice(0, 80)}\` in ${service.name}`,
      });
      const { execResponse } = await import("@/server/services/console");
      return execResponse(target, body.command, request.signal);
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/terminal",
    tag: "Console",
    summary: "Open a shell in a container",
    description:
      "An interactive shell with a TTY (bash when the image has it, else sh; a helper container for images without a shell). With command, that command runs with a TTY instead (with sh, and the database client defaults the shell has), and the session ends with it. Read its output from GET .../terminal/{id} and type with POST .../terminal/{id}.",
    needs: ["console.access"],
    status: 201,
    body: z.object({ command: z.string().trim().min(1).max(4000).optional(), ...pick, ...size }),
    handler: async ({ auth, params, body }) => {
      const service = await consoleService(auth, params.serviceId);
      const target = await container(service, body);
      const { openSession, containerCommand } = await import("@/server/services/terminal");
      let session: Awaited<ReturnType<typeof openSession>>;
      try {
        session = await openSession({
          userId: auth.userId,
          scope: `service:${service.id}`,
          containerId: target.id,
          containerName: target.name,
          cols: body.cols,
          rows: body.rows,
          docker: target.docker,
          ...(body.command ? { cmd: containerCommand(body.command) } : {}),
        });
      } catch (e) {
        throw new ApiError(502, `Could not start a shell: ${(e as Error).message}`);
      }
      const { logActivity } = await import("@/server/activity");
      await logActivity({
        userId: auth.userId,
        projectId: service.projectId,
        action: "service.terminal",
        targetType: "service",
        targetId: service.id,
        message: body.command ? `Ran \`${body.command.slice(0, 80)}\` in ${service.name}` : `Opened a terminal in ${service.name}`,
      });
      return { id: session.id, container: target.name };
    },
  }),
  ...sessionRoutes("/services/{serviceId}", "Console", ["console.access"], serviceSession, "serviceId"),

  route({
    method: "POST",
    path: "/servers/{serverId}/terminal",
    tag: "Console",
    summary: "Open a shell on a server",
    description:
      "A root shell on the server itself (on the dashboard's own machine through the host, elsewhere over SSH as the server's user), like the server's Terminal page: for admins who manage the server. With command, that command runs with a TTY instead of the shell, and the session ends with its exit code.",
    needs: ["admin", "console.access"],
    status: 201,
    body: z.object({ command: z.string().trim().min(1).max(4000).optional(), ...size }),
    handler: async ({ auth, params, body }) => {
      const { ctx, row } = await managedServer(params.serverId);
      const { openHostSession } = await import("@/server/services/terminal");
      let session: Awaited<ReturnType<typeof openHostSession>>;
      try {
        session = await openHostSession({ userId: auth.userId, cols: body.cols, rows: body.rows, serverId: row.id, command: body.command });
      } catch (e) {
        const message = (e as Error).message;
        throw new ApiError(message === "Server not found." ? 404 : 502, `Could not start a shell on ${row.name}: ${message}`);
      }
      const { logActivity } = await import("@/server/activity");
      await logActivity({
        userId: auth.userId,
        organizationId: ctx.org.id,
        action: "server.terminal",
        message: body.command
          ? `Ran \`${body.command.slice(0, 80)}\` on ${row.isLocal ? "the host" : row.name}`
          : row.isLocal
            ? "Opened a host terminal"
            : `Opened a terminal on ${row.name}`,
      });
      return { id: session.id, server: row.name };
    },
  }),
  ...sessionRoutes("/servers/{serverId}", "Console", ["admin", "console.access"], serverSession, "serverId"),
];
