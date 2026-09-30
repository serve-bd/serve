import dns from "node:dns/promises";
import net from "node:net";
import os from "node:os";
import { timingSafeEqual } from "node:crypto";
import { isNotNull, eq } from "drizzle-orm";
import { type Connection, Server, utils } from "ssh2";
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

type Live = { serverId: string; conn: Connection; relay: net.Server | null; remote: string };

const store = globalThis as unknown as { __serveTunnels?: { listener: Server | null; live: Map<string, Live>; starting: Promise<void> | null } };
const state = (store.__serveTunnels ??= { listener: null, live: new Map(), starting: null });

const GATEWAY = "serve-tunnel-gateway";
const GATEWAY_IMAGE = "alpine/socat:latest";

async function setTunnel(serverId: string, patch: Partial<ServerTunnel>) {
  const [row] = await db.select({ tunnel: schema.server.tunnel }).from(schema.server).where(eq(schema.server.id, serverId));
  if (!row?.tunnel) return;
  await db
    .update(schema.server)
    .set({ tunnel: { ...row.tunnel, ...patch } })
    .where(eq(schema.server.id, serverId));
}

/** The server whose registered key this is, if any. */
async function serverForKey(blob: Buffer) {
  const rows = await db.select({ id: schema.server.id, tunnel: schema.server.tunnel }).from(schema.server).where(isNotNull(schema.server.tunnel));
  for (const r of rows) {
    if (!r.tunnel?.clientKey) continue;
    const key = utils.parseKey(r.tunnel.clientKey);
    if (key instanceof Error || Array.isArray(key)) continue;
    const pub = key.getPublicSSH();
    if (pub.length === blob.length && timingSafeEqual(pub, blob)) return { id: r.id, key, tunnel: r.tunnel };
  }
  return null;
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
    const web = await dns.lookup(process.env.SERVE_WEB_HOST ?? "serve", { all: true }).catch(() => []);
    peers = { at: Date.now(), ips: new Set([...own, ...web.map((w) => w.address)]) };
  }
  return peers.ips.has(ip);
}

/** Relay: connections to it go through the tunnel to the server's sshd. */
function openRelay(live: Live, relayPort: number, bindAddr: string, bindPort: number) {
  const relay = net.createServer(async (sock) => {
    if (!(await allowedPeer(sock.remoteAddress))) {
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

function onClient(conn: Connection, info: { ip: string }) {
  let live: Live | null = null;
  conn.on("authentication", async (ctx) => {
    if (ctx.method !== "publickey") return ctx.reject(["publickey"]);
    const found = await serverForKey(ctx.key.data).catch(() => null);
    if (!found) return ctx.reject(["publickey"]);
    if (!ctx.signature) return ctx.accept();
    if (found.key.verify(ctx.blob as Buffer, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(["publickey"]);
    // A server connects once: a newer connection replaces an older one (after a network change).
    drop(found.id, undefined, true);
    live = { serverId: found.id, conn, relay: null, remote: info.ip };
    state.live.set(found.id, live);
    ctx.accept();
  });
  conn.on("ready", () => {
    if (!live) return conn.end();
    const current = live;
    conn.on("request", async (accept, reject, name, reqInfo) => {
      if (name !== "tcpip-forward" || current.relay) return reject?.();
      const [row] = await db.select({ tunnel: schema.server.tunnel, status: schema.server.status }).from(schema.server).where(eq(schema.server.id, current.serverId));
      if (!row?.tunnel) return reject?.();
      const { bindAddr, bindPort } = reqInfo as { bindAddr: string; bindPort: number };
      current.relay = openRelay(current, row.tunnel.relayPort, bindAddr, bindPort);
      accept?.(bindPort || 22);
      await setTunnel(current.serverId, { connectedAt: new Date().toISOString(), remote: current.remote });
      // A new server is set up now; a known one is checked right away instead of within a minute.
      const { enqueue } = await import("@/server/queue");
      if (row.status === "pending") await enqueue("server.setup", { serverId: current.serverId }, { concurrencyKey: `server:${current.serverId}` }).catch(() => {});
      else void import("@/server/servers/setup").then((m) => m.probeServer(current.serverId)).catch(() => {});
    });
    // No shell, no commands, no connections into Serve's own network.
    conn.on("session", (_accept, reject) => reject());
    conn.on("tcpip", (_accept, reject) => reject());
  });
  conn.on("close", () => live && drop(live.serverId, conn));
  conn.on("error", () => live && drop(live.serverId, conn));
}

async function report(listening: boolean, error: string | null) {
  await updateSettings({ tunnelListener: { port: tunnelPort(), listening, error, at: new Date().toISOString() } }).catch(() => {});
}

async function startListener() {
  const { privateKey } = await tunnelHostKey();
  const listener = new Server({ hostKeys: [privateKey], ident: "Serve-tunnel" }, onClient);
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(tunnelPort(), "0.0.0.0", () => {
      listener.off("error", reject);
      resolve();
    });
  });
  listener.on("error", (error: Error) => console.error(`[tunnel] ${error.message}`));
  state.listener = listener;
  await report(true, null);
}

function stopListener() {
  for (const id of [...state.live.keys()]) drop(id);
  state.listener?.close();
  state.listener = null;
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
    const rows = await db.select({ id: schema.server.id, tunnel: schema.server.tunnel }).from(schema.server).where(isNotNull(schema.server.tunnel));
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
    } catch (error) {
      await report(true, `Could not publish port ${tunnelPort()}: ${(error as Error).message}`);
    }
    const known = new Set(rows.map((r) => r.id));
    for (const id of [...state.live.keys()]) if (!known.has(id)) drop(id);
    // A server marked connected here but not live (the worker restarted) is not connected.
    for (const r of rows) if (r.tunnel?.connectedAt && !state.live.has(r.id)) await setTunnel(r.id, { connectedAt: null, remote: null });
  })().finally(() => {
    state.starting = null;
  });
  return state.starting;
}

export function shutdownTunnels() {
  stopListener();
}
