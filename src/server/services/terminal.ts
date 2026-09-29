import crypto from "node:crypto";
import type { Duplex } from "node:stream";
import type Docker from "dockerode";
import { docker as localDocker, imageExists, LABEL, pullImage, removeContainer } from "@/server/docker/client";
import { getServer } from "@/server/servers/context";
import { shellChannel } from "@/server/servers/ssh";

/**
 * Interactive shells: inside containers (docker exec with a TTY) or on a
 * server itself (nsenter locally, an SSH shell on remote servers).
 *
 * Route handlers cannot upgrade to WebSockets, so a session lives in this
 * process: output is fanned out to Server-Sent Event subscribers and input
 * arrives through small POST requests. Output is kept in a bounded buffer so a
 * reconnecting browser can replay what it missed.
 */

type Listener = (event: { type: "data"; seq: number; data: Buffer } | { type: "exit"; code: number | null }) => void;

/** What a session runs on: resizing and the exit status differ between Docker exec and SSH. */
type Backend = { resize(cols: number, rows: number): Promise<void>; exitCode(): Promise<number | null> };

type Session = {
  id: string;
  userId: string;
  /** Who the session belongs to, like `service:<id>` or `host:<serverId>`. */
  scope: string;
  containerName: string;
  onClose?: () => void;
  backend: Backend;
  stream: Duplex;
  chunks: { seq: number; data: Buffer }[];
  bufferedBytes: number;
  seq: number;
  exited: boolean;
  exitCode: number | null;
  listeners: Set<Listener>;
  idleTimer: NodeJS.Timeout | null;
  createdAt: number;
};

const MAX_BUFFER = 256 * 1024;
const IDLE_MS = 60_000;
const MAX_PER_USER = 8;

// Survive module reloads in development.
const store = globalThis as unknown as { __serveTerminals?: Map<string, Session> };
const sessions = (store.__serveTerminals ??= new Map());

/** Start bash when the image has it, else sh. Database images get their client defaults. */
const SHELL = [
  'if [ -n "$POSTGRES_USER" ]; then export PGUSER="$POSTGRES_USER" PGDATABASE="${POSTGRES_DB:-$POSTGRES_USER}"; fi',
  'if [ -n "$POSTGRES_PASSWORD" ]; then export PGPASSWORD="$POSTGRES_PASSWORD"; fi',
  'if [ -n "$MYSQL_ROOT_PASSWORD" ]; then export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; fi',
  'if [ -n "$MARIADB_ROOT_PASSWORD" ]; then export MYSQL_PWD="$MARIADB_ROOT_PASSWORD"; fi',
  "cd ~ 2>/dev/null || true",
  "if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi",
].join("; ");

function scheduleIdle(session: Session) {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = null;
  if (session.listeners.size === 0) session.idleTimer = setTimeout(() => closeSession(session.id), session.exited ? 5_000 : IDLE_MS);
}

function emit(session: Session, event: Parameters<Listener>[0]) {
  for (const listener of session.listeners) listener(event);
}

async function finish(session: Session) {
  if (session.exited) return;
  session.exited = true;
  session.exitCode = await session.backend.exitCode().catch(() => null);
  emit(session, { type: "exit", code: session.exitCode });
  scheduleIdle(session);
}

function evictOldest(userId: string) {
  const owned = [...sessions.values()].filter((s) => s.userId === userId).sort((a, b) => a.createdAt - b.createdAt);
  // Oldest sessions make room instead of refusing a new tab.
  while (owned.length >= MAX_PER_USER) closeSession(owned.shift()!.id);
}

function track(opts: { userId: string; scope: string; containerName: string; onClose?: () => void }, backend: Backend, stream: Duplex) {
  const session: Session = {
    id: crypto.randomBytes(16).toString("hex"),
    userId: opts.userId,
    scope: opts.scope,
    containerName: opts.containerName,
    onClose: opts.onClose,
    backend,
    stream,
    chunks: [],
    bufferedBytes: 0,
    seq: 0,
    exited: false,
    exitCode: null,
    listeners: new Set(),
    idleTimer: null,
    createdAt: Date.now(),
  };
  sessions.set(session.id, session);

  stream.on("data", (data: Buffer) => {
    const chunk = { seq: ++session.seq, data };
    session.chunks.push(chunk);
    session.bufferedBytes += data.length;
    while (session.bufferedBytes > MAX_BUFFER && session.chunks.length > 1) session.bufferedBytes -= session.chunks.shift()!.data.length;
    emit(session, { type: "data", ...chunk });
  });
  stream.on("end", () => void finish(session));
  stream.on("close", () => void finish(session));
  stream.on("error", () => void finish(session));
  return session;
}

export async function openSession(opts: {
  userId: string;
  scope: string;
  containerId: string;
  containerName: string;
  cols: number;
  rows: number;
  /** Command to run with a TTY. Defaults to a login shell inside the container. */
  cmd?: string[];
  /** Called once when the session is closed and removed. */
  onClose?: () => void;
  /** Docker client of the container's server (defaults to the local server). */
  docker?: Docker;
}) {
  evictOldest(opts.userId);
  const docker = opts.docker ?? localDocker;
  const exec = await docker.getContainer(opts.containerId).exec({
    Cmd: opts.cmd ?? ["sh", "-c", SHELL],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Env: ["TERM=xterm-256color", "COLORTERM=truecolor", "LANG=C.UTF-8"],
  });
  const stream = (await exec.start({ hijack: true, stdin: true, Tty: true })) as unknown as Duplex;
  const backend: Backend = {
    resize: async (cols, rows) => void (await exec.resize({ w: cols, h: rows }).catch(() => {})),
    exitCode: async () => (await exec.inspect().catch(() => null))?.ExitCode ?? null,
  };
  const session = track(opts, backend, stream);
  await resizeSession(session, opts.cols, opts.rows);
  scheduleIdle(session);
  return session;
}

export function getSession(id: string, userId: string) {
  const session = sessions.get(id);
  return session && session.userId === userId ? session : null;
}

/** Replays output after `since`, then streams until the listener is removed. */
export function subscribe(session: Session, since: number, listener: Listener) {
  for (const chunk of session.chunks) if (chunk.seq > since) listener({ type: "data", ...chunk });
  if (session.exited) listener({ type: "exit", code: session.exitCode });
  session.listeners.add(listener);
  scheduleIdle(session);
  return () => {
    session.listeners.delete(listener);
    scheduleIdle(session);
  };
}

export function writeSession(session: Session, data: string) {
  if (!session.exited) session.stream.write(data);
}

export async function resizeSession(session: Session, cols: number, rows: number) {
  if (session.exited) return;
  const w = Math.max(10, Math.min(500, Math.floor(cols)));
  const h = Math.max(4, Math.min(200, Math.floor(rows)));
  await session.backend.resize(w, h).catch(() => {});
}

export function closeSession(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (!session.exited) {
    // "exit" ends an interactive shell; destroying the stream covers a hung one.
    try {
      session.stream.write("\u0003\u0004exit\n");
    } catch {}
    setTimeout(() => session.stream.destroy(), 500);
  }
  emit(session, { type: "exit", code: session.exitCode });
  session.listeners.clear();
  session.onClose?.();
}

/** Number of open sessions in a scope. */
export function countSessions(scope: string) {
  let n = 0;
  for (const s of sessions.values()) if (s.scope === scope) n++;
  return n;
}

/* -------------------------------------------------------------------------- */
/*                                 Host shell                                 */
/* -------------------------------------------------------------------------- */

/** Session scope for a server's host shell. */
export function hostScope(serverId: string) {
  return `host:${serverId}`;
}

const HOST_CONTAINER = "serve-host-shell";
const HOST_IMAGE = "alpine:3.22";
const HOST_IDLE_MS = 30_000;

const hostStore = globalThis as unknown as { __serveHostShellTimer?: NodeJS.Timeout | null; __serveHostShellReady?: Promise<string> | null };

/**
 * A privileged helper sharing the host's PID namespace. `nsenter -t 1` from it
 * enters every namespace of the host's init process, which gives a real host shell.
 */
async function ensureHostContainer(): Promise<string> {
  const info = await localDocker
    .getContainer(HOST_CONTAINER)
    .inspect()
    .catch(() => null);
  if (info?.State.Running) return info.Id;
  if (info) await removeContainer(HOST_CONTAINER, 1);
  if (!(await imageExists(HOST_IMAGE))) await pullImage(HOST_IMAGE);
  const container = await localDocker.createContainer({
    name: HOST_CONTAINER,
    Image: HOST_IMAGE,
    Cmd: ["sleep", "infinity"],
    Labels: { [LABEL.managed]: "true", [LABEL.kind]: "host-shell" },
    HostConfig: {
      Privileged: true,
      PidMode: "host",
      NetworkMode: "host",
      AutoRemove: false,
      RestartPolicy: { Name: "no" },
      // Allocate TTYs from the host's devpts so the shell's terminal exists inside the host mount namespace.
      Binds: ["/dev/pts:/dev/pts"],
    },
  });
  await container.start();
  return container.id;
}

function scheduleHostCleanup(scope: string) {
  if (hostStore.__serveHostShellTimer) clearTimeout(hostStore.__serveHostShellTimer);
  hostStore.__serveHostShellTimer = setTimeout(() => {
    hostStore.__serveHostShellTimer = null;
    if (countSessions(scope) === 0) void removeContainer(HOST_CONTAINER, 1);
  }, HOST_IDLE_MS);
}

const HOST_SHELL = [
  "export TERM=xterm-256color COLORTERM=truecolor",
  "cd ~ 2>/dev/null || cd /",
  "if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi",
].join("; ");

/** Open a root shell on a server: nsenter on the local host, a login shell over SSH elsewhere. */
export async function openHostSession(opts: { userId: string; cols: number; rows: number; serverId?: string }) {
  const server = await getServer(opts.serverId);
  const scope = hostScope(server.id);
  if (!server.local) {
    evictOldest(opts.userId);
    const cols = Math.max(10, Math.min(500, Math.floor(opts.cols)));
    const rows = Math.max(4, Math.min(200, Math.floor(opts.rows)));
    const channel = await shellChannel(server.ssh!, { cols, rows });
    let exitCode: number | null = null;
    channel.once("exit", (code: number | null) => (exitCode = code));
    const backend: Backend = {
      resize: async (c, r) => void channel.setWindow(r, c, 0, 0),
      exitCode: async () => exitCode,
    };
    const session = track({ userId: opts.userId, scope, containerName: `${server.row.username}@${server.row.host}` }, backend, channel as unknown as Duplex);
    scheduleIdle(session);
    return session;
  }
  if (hostStore.__serveHostShellTimer) {
    clearTimeout(hostStore.__serveHostShellTimer);
    hostStore.__serveHostShellTimer = null;
  }
  // Concurrent opens share one container start.
  hostStore.__serveHostShellReady ??= ensureHostContainer().finally(() => {
    hostStore.__serveHostShellReady = null;
  });
  const containerId = await hostStore.__serveHostShellReady;
  return openSession({
    userId: opts.userId,
    scope,
    containerId,
    containerName: HOST_CONTAINER,
    cols: opts.cols,
    rows: opts.rows,
    cmd: ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "sh", "-c", HOST_SHELL],
    onClose: () => scheduleHostCleanup(scope),
  });
}
