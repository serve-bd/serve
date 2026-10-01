import crypto from "node:crypto";
import { Duplex } from "node:stream";
import { Client, utils, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2";

/**
 * Persistent SSH connections to remote servers.
 *
 * Every consumer (Docker API, file transfers, commands, terminals) opens
 * channels on shared connections, so only the first call pays for the
 * handshake. sshd limits channels per connection (MaxSessions, 10 by
 * default), so each server gets a small pool: a new connection opens when
 * the others are busy. Idle connections close after a few minutes.
 */

export type SshTarget = {
  id: string;
  host: string;
  port: number;
  username: string;
  privateKey: string;
  /** Pinned host key ("<type> <base64>"). Null accepts and reports the key (first connection). */
  hostKey: string | null;
};

type Conn = { client: Client; ready: Promise<Client>; channels: number; idle: NodeJS.Timeout | null; sftp: Promise<SFTPWrapper> | null; closed: boolean };
type Pool = { key: string; conns: Conn[] };

const IDLE_MS = 5 * 60_000;
/** Stay below sshd's default MaxSessions of 10. */
const CHANNELS_PER_CONN = 8;
const MAX_CONNS = 4;
const store = globalThis as unknown as { __serveSshPools?: Map<string, Pool> };
const pools: Map<string, Pool> = (store.__serveSshPools ??= new Map());

export class HostKeyMismatchError extends Error {
  constructor(public presented: string) {
    super("The server's SSH host key changed since it was added. If the server was reinstalled, reset the host key in the server settings.");
  }
}

/** "<type> <base64>" for a raw host key blob. */
export function formatHostKey(blob: Buffer) {
  const parsed = utils.parseKey(blob);
  if (parsed instanceof Error) return `unknown ${blob.toString("base64")}`;
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  return `${key.type} ${key.getPublicSSH().toString("base64")}`;
}

/** SHA256 fingerprint in OpenSSH style (SHA256:…). */
export function fingerprint(publicKeyLine: string) {
  const b64 = publicKeyLine.trim().split(/\s+/)[1] ?? "";
  return `SHA256:${crypto.createHash("sha256").update(Buffer.from(b64, "base64")).digest("base64").replace(/=+$/, "")}`;
}

function connKey(t: SshTarget) {
  return `${t.username}@${t.host}:${t.port}|${crypto.createHash("sha256").update(t.privateKey).digest("hex")}|${t.hostKey ?? ""}`;
}

function dropConn(id: string, conn: Conn) {
  conn.closed = true;
  if (conn.idle) clearTimeout(conn.idle);
  const pool = pools.get(id);
  if (pool) {
    pool.conns = pool.conns.filter((c) => c !== conn);
    if (!pool.conns.length) pools.delete(id);
  }
}

function touch(conn: Conn, id: string) {
  if (conn.idle) clearTimeout(conn.idle);
  conn.idle =
    conn.channels > 0
      ? null
      : setTimeout(() => {
          dropConn(id, conn);
          conn.client.end();
        }, IDLE_MS);
}

export function closeConnection(id: string) {
  const pool = pools.get(id);
  if (!pool) return;
  pools.delete(id);
  for (const conn of pool.conns) {
    conn.closed = true;
    if (conn.idle) clearTimeout(conn.idle);
    conn.client.end();
  }
}

function pool(t: SshTarget) {
  const key = connKey(t);
  const existing = pools.get(t.id);
  if (existing && existing.key === key) return existing;
  if (existing) closeConnection(t.id);
  const fresh: Pool = { key, conns: [] };
  pools.set(t.id, fresh);
  return fresh;
}

function openConn(t: SshTarget, opts: { onHostKey?: (key: string) => void; timeoutMs?: number } = {}): Conn {
  const client = new Client();
  let presented: string | null = null;
  const config: ConnectConfig = {
    host: t.host,
    port: t.port,
    username: t.username,
    privateKey: t.privateKey,
    readyTimeout: opts.timeoutMs ?? 15_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 4,
    hostVerifier: (blob: Buffer) => {
      presented = formatHostKey(blob);
      opts.onHostKey?.(presented);
      // Without a pinned key only the setup run (which reports and pins the key) may connect.
      return t.hostKey ? t.hostKey === presented : !!opts.onHostKey;
    },
  };
  const conn: Conn = { client, ready: null as unknown as Promise<Client>, channels: 0, idle: null, sftp: null, closed: false };
  conn.ready = new Promise<Client>((resolve, reject) => {
    client.once("ready", () => resolve(client));
    client.once("error", (error) => {
      dropConn(t.id, conn);
      if (presented && t.hostKey && presented !== t.hostKey) reject(new HostKeyMismatchError(presented));
      else reject(friendlySshError(error, t));
    });
    client.once("close", () => dropConn(t.id, conn));
  });
  pool(t).conns.push(conn);
  client.connect(config);
  conn.ready.then(() => touch(conn, t.id)).catch(() => {});
  return conn;
}

/** The first connection of the pool (opened when missing). `onHostKey` sees the key presented at the handshake. */
async function primary(t: SshTarget, opts: { onHostKey?: (key: string) => void; timeoutMs?: number } = {}) {
  const p = pool(t);
  const conn = p.conns.find((c) => !c.closed) ?? openConn(t, opts);
  await conn.ready;
  return conn;
}

/** Opens (or reuses) a connection; used to validate access. */
export async function connect(t: SshTarget, opts: { onHostKey?: (key: string) => void; timeoutMs?: number } = {}): Promise<Client> {
  return (await primary(t, opts)).client;
}

/** Reserves a channel slot on a connection with room, opening a new connection when all are busy. */
async function acquire(t: SshTarget): Promise<Conn> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const p = pool(t);
    const live = p.conns.filter((c) => !c.closed);
    let conn = live.find((c) => c.channels < CHANNELS_PER_CONN);
    if (!conn && live.length < MAX_CONNS) conn = openConn(t);
    if (conn) {
      conn.channels++;
      touch(conn, t.id);
      try {
        await conn.ready;
        return conn;
      } catch (error) {
        conn.channels--;
        throw error;
      }
    }
    if (Date.now() > deadline) throw new Error("Too many open sessions to this server. Close some terminals or log views and try again.");
    await new Promise((r) => setTimeout(r, 100));
  }
}

function friendlySshError(error: Error & { level?: string; code?: string }, t: SshTarget) {
  const where = `${t.username}@${t.host}:${t.port}`;
  if (error.level === "client-authentication") return new Error(`SSH rejected the key for ${where}. Add the public key to ~/.ssh/authorized_keys of ${t.username}.`);
  if (error.code === "ECONNREFUSED") return new Error(`Connection refused by ${t.host}:${t.port}. Is SSH running and the port open?`);
  if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") return new Error(`Could not resolve ${t.host}.`);
  if (error.code === "ETIMEDOUT" || /timed out/i.test(error.message)) return new Error(`Timed out connecting to ${where}. Check the address and firewall.`);
  return new Error(`SSH error for ${where}: ${error.message}`);
}

async function channel<T>(t: SshTarget, open: (client: Client) => Promise<T & { once(event: "close", fn: () => void): unknown }>): Promise<T> {
  const conn = await acquire(t);
  const release = () => {
    conn.channels = Math.max(0, conn.channels - 1);
    touch(conn, t.id);
  };
  try {
    let ch!: T & { once(event: "close", fn: () => void): unknown };
    // sshd may allow fewer sessions than we assume; wait for one to free up.
    for (let attempt = 0; ; attempt++) {
      try {
        ch = await open(conn.client);
        break;
      } catch (error) {
        if (!/Channel open failure/i.test((error as Error).message) || attempt >= 40) throw error;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    ch.once("close", release);
    return ch;
  } catch (error) {
    release();
    throw error;
  }
}

/** Raw exec channel. Callers handle stdout/stderr and the exit code. */
export function execChannel(t: SshTarget, command: string, opts: { pty?: { cols: number; rows: number } | false; env?: Record<string, string> } = {}) {
  return channel<ClientChannel>(
    t,
    (client) =>
      new Promise((resolve, reject) => {
        client.exec(
          command,
          { pty: opts.pty ? { term: "xterm-256color", cols: opts.pty.cols, rows: opts.pty.rows } : false, env: opts.env as NodeJS.ProcessEnv | undefined },
          (err, ch) => (err ? reject(err) : resolve(ch)),
        );
      }),
  );
}

/** Interactive login shell with a PTY. */
export function shellChannel(t: SshTarget, size: { cols: number; rows: number }) {
  return channel<ClientChannel>(
    t,
    (client) =>
      new Promise((resolve, reject) => {
        client.shell({ term: "xterm-256color", cols: size.cols, rows: size.rows }, (err, ch) => (err ? reject(err) : resolve(ch)));
      }),
  );
}

export type SshExecResult = { code: number; stdout: string; stderr: string };

/** Run a command and collect its output. Rejects only on connection errors. */
export async function sshExec(
  t: SshTarget,
  command: string,
  opts: {
    onLine?: (line: string) => void;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Input. Pass a function to create the stream only once the channel is open (child process output is lost otherwise). */
    stdin?: NodeJS.ReadableStream | string | (() => NodeJS.ReadableStream);
  } = {},
): Promise<SshExecResult> {
  const ch = await execChannel(t, command);
  let stdout = "";
  let stderr = "";
  let partial = "";
  const emit = (text: string) => {
    if (!opts.onLine) return;
    partial += text;
    const lines = partial.split(/\r?\n/);
    partial = lines.pop() ?? "";
    for (const line of lines) opts.onLine(line);
  };
  ch.on("data", (d: Buffer) => {
    const text = d.toString("utf8");
    if (stdout.length < 4_000_000) stdout += text;
    emit(text);
  });
  ch.stderr.on("data", (d: Buffer) => {
    const text = d.toString("utf8");
    if (stderr.length < 1_000_000) stderr += text;
    emit(text);
  });
  const input = typeof opts.stdin === "function" ? opts.stdin() : opts.stdin;
  if (typeof input === "string") ch.end(input);
  else if (input) input.pipe(ch);
  else ch.end();

  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let exitCode: number | null = null;
    let settled = false;
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (partial && opts.onLine) opts.onLine(partial);
      partial = "";
      resolve({ code, stdout, stderr });
    };
    // "exit" carries the status; "close" comes last, after all output was read.
    ch.once("exit", (code: number | null, signal?: string) => (exitCode = code ?? (signal ? 128 : 1)));
    ch.once("close", () => done(exitCode ?? 1));
    if (opts.timeoutMs) timer = setTimeout(() => (ch.close(), done(124)), opts.timeoutMs);
    opts.signal?.addEventListener("abort", () => (ch.close(), done(130)));
  });
}

export async function sftp(t: SshTarget): Promise<SFTPWrapper> {
  const conn = await primary(t);
  if (!conn.sftp) {
    const session = new Promise<SFTPWrapper>((resolve, reject) => conn.client.sftp((err, s) => (err ? reject(err) : resolve(s))));
    conn.sftp = session;
    const reset = () => {
      if (conn.sftp === session) conn.sftp = null;
    };
    // One listener per session, not per call.
    session.then((s) => s.once("close", reset), reset);
  }
  return conn.sftp;
}

/** A socket-like stream to the remote Docker API (`docker system dial-stdio`). */
export async function dockerStream(t: SshTarget): Promise<Duplex> {
  const ch = await execChannel(t, "docker system dial-stdio");
  // Node's HTTP client calls these on sockets; SSH channels do not implement them.
  const socket = ch as unknown as Duplex & Record<string, unknown>;
  for (const name of ["setNoDelay", "setKeepAlive", "ref", "unref"]) if (typeof socket[name] !== "function") socket[name] = () => socket;
  if (typeof socket.setTimeout !== "function") socket.setTimeout = () => socket;
  // ssh2's destroy() only closes the SSH channel and never emits "close", so Node's HTTP agent
  // would keep counting the connection as busy. Destroy the stream too.
  const sshDestroy = ch.destroy.bind(ch);
  socket.destroy = (error?: Error) => {
    sshDestroy();
    if (!socket.destroyed) Duplex.prototype.destroy.call(socket, error);
    return socket;
  };
  // Node's HTTP client ends a finished connection with destroySoon (a net.Socket method).
  if (typeof socket.destroySoon !== "function")
    socket.destroySoon = () => {
      if (socket.writable) socket.end();
      if (socket.writableFinished) socket.destroy();
      else socket.once("finish", () => socket.destroy());
    };
  // ssh2 only reports a closed channel once its data was read to the end. When Docker closes a
  // connection nobody reads any more (a finished response), drain it, so the HTTP agent sees the
  // close and frees the slot. Otherwise a few such connections fill the pool and every later
  // Docker call to the server waits forever.
  const push = ch.push.bind(ch);
  ch.push = (chunk: unknown, encoding?: BufferEncoding) => {
    const more = push(chunk, encoding);
    if (chunk === null)
      setImmediate(() => {
        if (!socket.readableEnded && socket.listenerCount("data") === 0) socket.resume();
      });
    return more;
  };
  return socket;
}

/** Single-quote a value for a POSIX shell. */
export function sh(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
