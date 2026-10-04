import crypto from "node:crypto";
import type { Duplex } from "node:stream";
import type Docker from "dockerode";
import { docker as localDocker, execExitCode, imageExists, LABEL, pullImage, removeContainer } from "@/server/docker/client";
import { getServer } from "@/server/servers/context";
import type { ClientChannel } from "ssh2";
import { execChannel, shellChannel } from "@/server/servers/ssh";

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

/** Database images get their client defaults (psql, mysql log in without asking). */
const CLIENT_DEFAULTS = [
  'if [ -n "$POSTGRES_USER" ]; then export PGUSER="$POSTGRES_USER" PGDATABASE="${POSTGRES_DB:-$POSTGRES_USER}"; fi',
  'if [ -n "$POSTGRES_PASSWORD" ]; then export PGPASSWORD="$POSTGRES_PASSWORD"; fi',
  'if [ -n "$MYSQL_ROOT_PASSWORD" ]; then export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; fi',
  'if [ -n "$MARIADB_ROOT_PASSWORD" ]; then export MYSQL_PWD="$MARIADB_ROOT_PASSWORD"; fi',
];

/** Start bash when the image has it, else sh. */
const SHELL = [...CLIENT_DEFAULTS, "cd ~ 2>/dev/null || true", "if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi"].join("; ");

/** One command with a TTY in a container, with the same client defaults as the shell. */
export const containerCommand = (command: string) => ["sh", "-c", [...CLIENT_DEFAULTS, command].join("; ")];

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
  let containerId = opts.containerId;
  let cmd = opts.cmd ?? ["sh", "-c", SHELL];
  let onClose = opts.onClose;
  // Minimal images (distroless, scratch) have no shell: attach a helper that shares the container's
  // processes, network and volumes instead, so there is still somewhere to look around.
  if (!opts.cmd && !(await hasShell(docker, opts.containerId))) {
    const helper = await startDebugHelper(docker, opts.containerId);
    containerId = helper;
    cmd = ["sh", "-c", DEBUG_SHELL];
    onClose = () => {
      opts.onClose?.();
      liveHelpers.delete(helper);
      void docker
        .getContainer(helper)
        .remove({ force: true })
        .catch(() => {});
    };
  }
  let exec: Docker.Exec;
  let stream: Duplex;
  try {
    exec = await docker.getContainer(containerId).exec({
      Cmd: cmd,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Env: ["TERM=xterm-256color", "COLORTERM=truecolor", "LANG=C.UTF-8"],
    });
    stream = (await exec.start({ hijack: true, stdin: true, Tty: true })) as unknown as Duplex;
  } catch (error) {
    // No session to close later: remove the helper now.
    if (containerId !== opts.containerId) onClose?.();
    throw error;
  }
  const backend: Backend = {
    resize: async (cols, rows) => void (await exec.resize({ w: cols, h: rows }).catch(() => {})),
    exitCode: async () => (await exec.inspect().catch(() => null))?.ExitCode ?? null,
  };
  const session = track({ ...opts, onClose }, backend, stream);
  await resizeSession(session, opts.cols, opts.rows);
  scheduleIdle(session);
  return session;
}

/** Whether `sh` runs in the container (it exits 126/127 when the image has none). */
async function hasShell(docker: Docker, containerId: string) {
  try {
    const exec = await docker.getContainer(containerId).exec({ Cmd: ["sh", "-c", "exit 0"], AttachStdout: true, AttachStderr: true });
    const stream = await exec.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve) => {
      stream.on("end", resolve);
      stream.on("close", resolve);
      stream.on("error", resolve);
      stream.resume();
    });
    return (await execExitCode(exec)) === 0;
  } catch {
    return false;
  }
}

const DEBUG_IMAGE = "alpine:3.22.6";

/** Helper containers of open sessions in this process (kept across reloads in development). */
const liveHelpers: Set<string> = ((globalThis as { __serveDebugHelpers?: Set<string> }).__serveDebugHelpers ??= new Set());

const DEBUG_SHELL = [
  "export TERM=xterm-256color COLORTERM=truecolor",
  `printf '\\033[33mThis image has no shell.\\033[0m You are in a helper container that shares its processes, network and volumes.\\r\\n'`,
  `printf 'Its files are under /proc/1/root (you start there). Tools: apk add <package>. Closing this tab removes the helper.\\r\\n\\r\\n'`,
  "cd /proc/1/root 2>/dev/null || cd /",
  "exec sh -l",
].join("; ");

/** A throwaway Alpine container in the target's PID and network namespaces, with its volumes. */
async function startDebugHelper(docker: Docker, containerId: string) {
  const target = await docker.getContainer(containerId).inspect();
  if (!target.State.Running) throw new Error("The container is not running.");
  if (!(await imageExists(DEBUG_IMAGE, docker))) await pullImage(DEBUG_IMAGE, undefined, null, docker);
  // Helpers left by a restart (their sessions are gone) are removed first: a day old and not ours.
  const stale = await docker.listContainers({ all: true, filters: { label: [`${LABEL.kind}=debug-shell`] } }).catch(() => []);
  for (const c of stale)
    if (!liveHelpers.has(c.Id) && Date.now() / 1000 - c.Created > 86_400)
      await docker
        .getContainer(c.Id)
        .remove({ force: true })
        .catch(() => {});
  const helper = await docker.createContainer({
    name: `serve-debug-${target.Id.slice(0, 12)}-${crypto.randomBytes(3).toString("hex")}`,
    Image: DEBUG_IMAGE,
    Cmd: ["sleep", "infinity"],
    Labels: { [LABEL.managed]: "true", [LABEL.kind]: "debug-shell" },
    HostConfig: {
      PidMode: `container:${target.Id}`,
      NetworkMode: `container:${target.Id}`,
      VolumesFrom: [target.Id],
      // Reading another process's root (/proc/1/root) needs ptrace access when it runs as another user.
      CapAdd: ["SYS_PTRACE"],
      AutoRemove: true,
      RestartPolicy: { Name: "no" },
    },
  });
  try {
    await helper.start();
  } catch (error) {
    // AutoRemove only applies once it has started.
    await helper.remove({ force: true }).catch(() => {});
    throw error;
  }
  liveHelpers.add(helper.id);
  return helper.id;
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
const HOST_IMAGE = "alpine:3.22.6";
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

/** One command in the host's namespaces, from the home folder like the shell. */
const hostCommand = (command: string) => `export TERM=xterm-256color COLORTERM=truecolor; cd ~ 2>/dev/null || cd /; ${command}`;

/**
 * Open a root shell on a server: nsenter on the local host, a login shell over SSH elsewhere.
 * With `command`, that command runs instead of the shell (with a TTY), and the session ends with it.
 */
export async function openHostSession(opts: { userId: string; cols: number; rows: number; serverId?: string; command?: string }) {
  const server = await getServer(opts.serverId);
  const scope = hostScope(server.id);
  if (!server.local) {
    evictOldest(opts.userId);
    const cols = Math.max(10, Math.min(500, Math.floor(opts.cols)));
    const rows = Math.max(4, Math.min(200, Math.floor(opts.rows)));
    let channel: ClientChannel;
    let exitCode: () => number | null;
    if (opts.command) {
      const ch = await execChannel(server.ssh!, opts.command, { pty: { cols, rows } });
      channel = ch;
      exitCode = ch.exitStatus;
    } else {
      let code: number | null = null;
      channel = await shellChannel(server.ssh!, { cols, rows });
      channel.once("exit", (c: number | null) => (code = c));
      exitCode = () => code;
    }
    const backend: Backend = {
      resize: async (c, r) => void channel.setWindow(r, c, 0, 0),
      exitCode: async () => exitCode(),
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
    cmd: ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "sh", "-c", opts.command ? hostCommand(opts.command) : HOST_SHELL],
    onClose: () => scheduleHostCleanup(scope),
  });
}
