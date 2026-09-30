import net from "node:net";
import os from "node:os";
import { timingSafeEqual } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { type Connection, type ParsedKey, Server, utils } from "ssh2";
import { db, schema } from "@/server/db";
import type { ServerTunnel } from "@/server/db/schema";
import { env } from "@/server/env";
import { LABEL, docker, imageExists, pullImage } from "@/server/docker/client";
import { updateSettings } from "@/server/settings";
import { relayBind, tunnelPort } from "./index";
import { tunnelHostKey } from "./host-key";

/**
 * The tunnel listener (worker only). It speaks just enough SSH for `ssh -R`: servers sign in with
 * the key they registered, may ask for one remote forward, and nothing else (no shell, no
 * connections into Serve's network). Each connected server gets a relay port that leads to its sshd.
 */

type Live = { serverId: string; conn: Connection; relay: net.Server | null; remote: string | null; clientKey: string };

const store = globalThis as unknown as { __serveTunnels?: { listener: net.Server | null; live: Map<string, Live>; starting: Promise<void> | null } };
const state = (store.__serveTunnels ??= { listener: null, live: new Map(), starting: null });

const GATEWAY = "serve-tunnel-gateway";
const GATEWAY_IMAGE = "alpine/socat:latest";

/** Change some tunnel fields in one statement, so a concurrent change of other fields is kept. */
async function setTunnel(serverId: string, patch: Partial<ServerTunnel>) {
  await db
    .update(schema.server)
    .set({ tunnel: sql`${schema.server.tunnel} || ${JSON.stringify(patch)}::jsonb` })
    .where(and(eq(schema.server.id, serverId), isNotNull(schema.server.tunnel)))
    .catch((error) => console.error(`[tunnel] ${(error as Error).message}`));
}

/** Registered tunnel keys, parsed once: a flood of sign-in attempts must not hit the database each time. */
type KnownKey = { id: string; key: ParsedKey; blob: Buffer; clientKey: string };
let known: { at: number; keys: KnownKey[] } | null = null;
async function loadKeys() {
  const rows = await db.select({ id: schema.server.id, tunnel: schema.server.tunnel }).from(schema.server).where(isNotNull(schema.server.tunnel));
  const keys: KnownKey[] = [];
  for (const r of rows) {
    if (!r.tunnel?.clientKey) continue;
    const key = utils.parseKey(r.tunnel.clientKey);
    if (key instanceof Error || Array.isArray(key)) continue;
    keys.push({ id: r.id, key, blob: key.getPublicSSH(), clientKey: r.tunnel.clientKey });
  }
  known = { at: Date.now(), keys };
  return keys;
}

/** The server whose registered key this is, if any (a key registered moments ago is found too). */
async function serverForKey(blob: Buffer) {
  const match = (keys: KnownKey[]) => keys.find((k) => k.blob.length === blob.length && timingSafeEqual(k.blob, blob)) ?? null;
  const cached = known ? match(known.keys) : null;
  if (cached) return cached;
  // Unknown key: look again, at most every two seconds.
  if (known && Date.now() - known.at < 2000) return null;
  return match(await loadKeys());
}

/** Close a server's tunnel. `replaced`: a new connection takes over, so it stays marked connected. */
function drop(serverId: string, conn?: Connection, replaced = false) {
  const live = state.live.get(serverId);
  if (!live || (conn && live.conn !== conn)) return;
  state.live.delete(serverId);
  live.relay?.close();
  live.conn.end();
  if (!replaced) void setTunnel(serverId, { connectedAt: null, remote: null });
}

/**
 * Who may use a relay: this process, and with Docker Compose also the web container. Other
 * containers on Serve's network could reach the relay port; they get nothing (the server's sshd
 * would still want Serve's key, but they should not get that far).
 */
let peers: { at: number; ips: Set<string> } | null = null;
async function allowedPeer(address: string | undefined) {
  if (!address) return false;
  const ip = address.replace(/^::ffff:/, "");
  if (ip === "127.0.0.1" || ip === "::1") return true;
  if (!process.env.SERVE_ROLE) return false;
  if (!peers || Date.now() - peers.at > 30_000) {
    const own = Object.values(os.networkInterfaces())
      .flat()
      .map((i) => i?.address)
      .filter((a): a is string => !!a);
    // The web container by its Docker name, which is unique; not a DNS name a stack could also answer to.
    const web = await docker
      .getContainer(process.env.SERVE_WEB_CONTAINER ?? "serve")
      .inspect()
      .then((c) => Object.values(c.NetworkSettings.Networks ?? {}).map((n) => n.IPAddress))
      .catch(() => [] as string[]);
    peers = { at: Date.now(), ips: new Set([...own, ...web.filter(Boolean)]) };
  }
  return peers.ips.has(ip);
}

/** Relay: connections to it go through the tunnel to the server's sshd. */
function openRelay(live: Live, relayPort: number, bindAddr: string, bindPort: number) {
  const relay = net.createServer(async (sock) => {
    // A reset while the checks below run must not become an uncaught error.
    sock.on("error", () => sock.destroy());
    if (!(await allowedPeer(sock.remoteAddress).catch(() => false))) {
      sock.destroy();
      return;
    }
    live.conn.forwardOut(bindAddr, bindPort, sock.remoteAddress ?? "127.0.0.1", sock.remotePort ?? 0, (error, channel) => {
      if (error) {
        sock.destroy();
        return;
      }
      sock.pipe(channel).pipe(sock);
      // ssh2 channels do not always emit close; end both sides from either one.
      const done = () => {
        sock.destroy();
        channel.destroy();
      };
      sock.on("close", done).on("error", done);
      channel.on("close", done).on("error", done).on("end", done);
    });
  });
  // The relay of a connection this one replaced may still be closing: try again for a few seconds.
  let tries = 0;
  relay.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && tries++ < 20 && state.live.get(live.serverId) === live) {
      setTimeout(() => relay.listen(relayPort, relayBind()), 250);
      return;
    }
    console.error(`[tunnel] relay ${relayPort}: ${error.message}`);
    drop(live.serverId, live.conn);
  });
  relay.listen(relayPort, relayBind());
  return relay;
}

/**
 * Connections are taken as plain TCP first: limits apply before any SSH is spoken (in total and
 * per address), and a connection that has not signed in within 15 seconds is closed, even one
 * that never sends a byte.
 */
const LIMITS = { total: 256, perIp: 16, signInMs: 15_000 };
const sockets = new Map<string, { sock: net.Socket; signedIn: boolean }>();
const perIp = new Map<string, number>();

function onSocket(sock: net.Socket, ssh: Server) {
  // With Docker Compose everyone arrives through the gateway container: one address for all.
  const ip = process.env.SERVE_ROLE ? "gateway" : (sock.remoteAddress ?? "?");
  const cap = process.env.SERVE_ROLE ? LIMITS.total : LIMITS.perIp;
  if (sockets.size >= LIMITS.total || (perIp.get(ip) ?? 0) >= cap) {
    sock.destroy();
    return;
  }
  const key = `${sock.remoteAddress}:${sock.remotePort}`;
  const entry = { sock, signedIn: false };
  sockets.set(key, entry);
  perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
  sock.setTimeout(LIMITS.signInMs, () => {
    if (!entry.signedIn) sock.destroy();
  });
  sock.on("error", () => sock.destroy());
  sock.on("close", () => {
    sockets.delete(key);
    const n = (perIp.get(ip) ?? 1) - 1;
    if (n > 0) perIp.set(ip, n);
    else perIp.delete(ip);
  });
  ssh.injectSocket(sock);
}

function onClient(conn: Connection, info: { ip: string; port: number }) {
  let live: Live | null = null;
  conn.on("authentication", async (ctx) => {
    if (ctx.method !== "publickey") return ctx.reject(["publickey"]);
    const found = await serverForKey(ctx.key.data).catch(() => null);
    if (!found) return ctx.reject(["publickey"]);
    if (!ctx.signature) return ctx.accept();
    if (found.key.verify(ctx.blob as Buffer, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(["publickey"]);
    // The cache may be seconds old: the key must still be this server's (not replaced by a new join,
    // not a removed server). Only signed attempts get here, so this lookup cannot be flooded.
    const [row] = await db
      .select({ tunnel: schema.server.tunnel })
      .from(schema.server)
      .where(eq(schema.server.id, found.id))
      .catch(() => []);
    if (row?.tunnel?.clientKey !== found.clientKey) {
      void loadKeys().catch(() => {});
      return ctx.reject(["publickey"]);
    }
    // A server connects once: a newer connection replaces an older one (after a network change).
    drop(found.id, undefined, true);
    // With Docker Compose every connection comes through the gateway container: its address says nothing.
    live = { serverId: found.id, conn, relay: null, remote: process.env.SERVE_ROLE ? null : info.ip, clientKey: found.clientKey };
    state.live.set(found.id, live);
    // Signed in: no deadline any more (SSH keepalives watch the connection from here).
    const entry = sockets.get(`${info.ip}:${info.port}`);
    if (entry) {
      entry.signedIn = true;
      entry.sock.setTimeout(0);
    }
    ctx.accept();
  });
  conn.on("ready", () => {
    if (!live) return conn.end();
    const current = live;
    conn.on("request", (accept, reject, name, reqInfo) => {
      if (name !== "tcpip-forward" || current.relay) return reject?.();
      void (async () => {
        const [row] = await db
          .select({ tunnel: schema.server.tunnel, status: schema.server.status, hostKey: schema.server.hostKey })
          .from(schema.server)
          .where(eq(schema.server.id, current.serverId));
        if (!row?.tunnel || state.live.get(current.serverId) !== current) return reject?.();
        const { bindAddr, bindPort } = reqInfo as { bindAddr: string; bindPort: number };
        current.relay = openRelay(current, row.tunnel.relayPort, bindAddr, bindPort);
        accept?.(bindPort || 22);
        await setTunnel(current.serverId, { connectedAt: new Date().toISOString(), remote: current.remote });
        // New or rejoined (its host key is not pinned yet): set it up, which pins the key. A known
        // one is checked right away instead of within a minute.
        if (row.status === "pending" || !row.hostKey) {
          const { enqueue } = await import("@/server/queue");
          await enqueue("server.setup", { serverId: current.serverId }, { concurrencyKey: `server:${current.serverId}` });
        } else await import("@/server/servers/setup").then((m) => m.probeServer(current.serverId));
      })().catch((error) => {
        console.error(`[tunnel] ${(error as Error).message}`);
        // Refused if not answered yet; once accepted, the connection just goes on.
        if (!current.relay) {
          try {
            reject?.();
          } catch {}
        }
      });
    });
    // No shell, no commands, no connections into Serve's own network.
    conn.on("session", (_accept, reject) => reject());
    conn.on("tcpip", (_accept, reject) => reject());
  });
  conn.on("close", () => live && drop(live.serverId, conn));
  conn.on("error", () => live && drop(live.serverId, conn));
}

let reported: string | null = null;
/** When the loop last asked to set up a connected server that waits for it. */
const setupAsked = new Map<string, number>();
async function report(listening: boolean, error: string | null) {
  reported = error;
  await updateSettings({ tunnelListener: { port: tunnelPort(), listening, error, at: new Date().toISOString() } }).catch(() => {});
}

async function startListener() {
  const { privateKey } = await tunnelHostKey();
  const ssh = new Server({ hostKeys: [privateKey], ident: "Serve-tunnel" }, onClient);
  const tcp = net.createServer((sock) => onSocket(sock, ssh));
  await new Promise<void>((resolve, reject) => {
    tcp.once("error", reject);
    tcp.listen(tunnelPort(), "0.0.0.0", () => {
      tcp.off("error", reject);
      resolve();
    });
  });
  tcp.on("error", (error: Error) => console.error(`[tunnel] ${error.message}`));
  state.listener = tcp;
  await report(true, null);
}

function stopListener() {
  for (const id of [...state.live.keys()]) drop(id);
  state.listener?.close();
  state.listener = null;
  for (const { sock } of sockets.values()) sock.destroy();
}

/** Installed with Docker Compose: a small container publishes the listener's port on the host. */
async function ensureGateway(on: boolean) {
  if (!process.env.SERVE_ROLE) return;
  const container = docker.getContainer(GATEWAY);
  const info = await container.inspect().catch(() => null);
  if (!on) {
    if (info) await container.remove({ force: true }).catch(() => {});
    return;
  }
  const port = String(tunnelPort());
  const bound = info?.HostConfig.PortBindings?.[`${port}/tcp`]?.[0]?.HostPort === port;
  if (info?.State.Running && bound) return;
  if (info) await container.remove({ force: true }).catch(() => {});
  if (!(await imageExists(GATEWAY_IMAGE))) await pullImage(GATEWAY_IMAGE);
  const created = await docker.createContainer({
    name: GATEWAY,
    Image: GATEWAY_IMAGE,
    Cmd: [`tcp-listen:${port},fork,reuseaddr`, `tcp-connect:serve-worker:${port}`],
    Labels: { [LABEL.managed]: "true", [LABEL.kind]: "tunnel-gateway" },
    ExposedPorts: { [`${port}/tcp`]: {} },
    HostConfig: {
      NetworkMode: env.network,
      PortBindings: { [`${port}/tcp`]: [{ HostPort: port }] },
      RestartPolicy: { Name: "unless-stopped" },
      LogConfig: { Type: "json-file", Config: { "max-size": "1m", "max-file": "1" } },
    },
  });
  await created.start();
}

/**
 * Worker loop: run the listener (and publish its port) while any server connects out, drop
 * connections of servers that were removed or got a new key, and stop when none are left.
 */
export async function syncTunnels() {
  if (state.starting) return state.starting;
  state.starting = (async () => {
    const rows = await db.select({ id: schema.server.id, tunnel: schema.server.tunnel, status: schema.server.status }).from(schema.server).where(isNotNull(schema.server.tunnel));
    if (!rows.length) {
      if (state.listener) stopListener();
      await ensureGateway(false).catch(() => {});
      return;
    }
    if (!state.listener) {
      try {
        await startListener();
      } catch (error) {
        await report(false, (error as Error).message);
        return;
      }
    }
    try {
      await ensureGateway(true);
      if (reported) await report(true, null);
    } catch (error) {
      await report(true, `Could not publish port ${tunnelPort()}: ${(error as Error).message}`);
    }
    await loadKeys();
    // Servers that were removed, or that joined again with a new key, lose their old connection.
    const keyOf = new Map(rows.map((r) => [r.id, r.tunnel?.clientKey ?? null]));
    for (const [id, live] of [...state.live]) if (keyOf.get(id) !== live.clientKey) drop(id);
    // A server marked connected here but not live (the worker restarted) is not connected.
    for (const r of rows) if (r.tunnel?.connectedAt && !state.live.has(r.id)) await setTunnel(r.id, { connectedAt: null, remote: null });
    // Connected but waiting to be set up (joined again over a tunnel that stayed up): set it up now.
    for (const r of rows) {
      if (r.status !== "pending" || !state.live.get(r.id)?.relay || Date.now() - (setupAsked.get(r.id) ?? 0) < 60_000) continue;
      setupAsked.set(r.id, Date.now());
      const { enqueue } = await import("@/server/queue");
      await enqueue("server.setup", { serverId: r.id }, { concurrencyKey: `server:${r.id}` }).catch(() => {});
    }
  })().finally(() => {
    state.starting = null;
  });
  return state.starting;
}

export function shutdownTunnels() {
  stopListener();
}
