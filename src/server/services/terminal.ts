import crypto from "node:crypto";
import type { Duplex } from "node:stream";
import type Docker from "dockerode";
import { docker } from "@/server/docker/client";

/**
 * Interactive shells inside containers (docker exec with a TTY).
 *
 * Route handlers cannot upgrade to WebSockets, so a session lives in this
 * process: output is fanned out to Server-Sent Event subscribers and input
 * arrives through small POST requests. Output is kept in a bounded buffer so a
 * reconnecting browser can replay what it missed.
 */

type Listener = (event: { type: "data"; seq: number; data: Buffer } | { type: "exit"; code: number | null }) => void;

type Session = {
  id: string;
  userId: string;
  serviceId: string;
  containerName: string;
  exec: Docker.Exec;
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
  const info = await session.exec.inspect().catch(() => null);
  session.exitCode = info?.ExitCode ?? null;
  emit(session, { type: "exit", code: session.exitCode });
  scheduleIdle(session);
}

export async function openSession(opts: { userId: string; serviceId: string; containerId: string; containerName: string; cols: number; rows: number }) {
  const owned = [...sessions.values()].filter((s) => s.userId === opts.userId).sort((a, b) => a.createdAt - b.createdAt);
  // Oldest sessions make room instead of refusing a new tab.
  while (owned.length >= MAX_PER_USER) closeSession(owned.shift()!.id);

  const exec = await docker.getContainer(opts.containerId).exec({
    Cmd: ["sh", "-c", SHELL],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Env: ["TERM=xterm-256color", "COLORTERM=truecolor", "LANG=C.UTF-8"],
  });
  const stream = (await exec.start({ hijack: true, stdin: true, Tty: true })) as unknown as Duplex;

  const session: Session = {
    id: crypto.randomBytes(16).toString("hex"),
    userId: opts.userId,
    serviceId: opts.serviceId,
    containerName: opts.containerName,
    exec,
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
  await session.exec.resize({ w, h }).catch(() => {});
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
}
