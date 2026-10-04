import net from "node:net";
import { eq, isNotNull } from "drizzle-orm";
import { db, schema } from "@/server/db";
import type { ServerTailscale } from "@/server/db/schema";
import { decrypt, encrypt } from "@/server/crypto";
import { dnsSuffixOf, deviceOnline, oauthToken, type TailscaleClient, tailscaleClient, type TailscaleDevice, tailnetIpv4 } from "./api";

/**
 * Tailscale for servers: Serve adds servers to a tailnet with single-use auth keys and reaches
 * their SSH at their Tailscale address. The machine the dashboard runs on must be in the tailnet
 * too; its containers reach 100.x addresses through the host.
 */

export type TailnetRow = typeof schema.tailscaleTailnet.$inferSelect;
type ServerRow = typeof schema.server.$inferSelect;

/** How long an auth key works: made when the join command runs, so a short time is enough. */
export const AUTH_KEY_TTL_SECONDS = 3600;

export async function getTailnet(id: string | null | undefined): Promise<TailnetRow | null> {
  if (!id) return null;
  const [row] = await db.select().from(schema.tailscaleTailnet).where(eq(schema.tailscaleTailnet.id, id));
  return row ?? null;
}

/**
 * API calls for a connected tailnet. An OAuth client's access token is kept (encrypted) until a
 * minute before it runs out, then a new one is fetched; a token refused early is renewed once.
 */
export function clientFor(row: TailnetRow, f?: typeof fetch): TailscaleClient {
  let cached = row.authType === "oauth" && row.accessToken && row.tokenExpiresAt ? { token: row.accessToken, expiresAt: row.tokenExpiresAt } : null;
  return tailscaleClient({
    tailnet: row.tailnet,
    renewable: row.authType === "oauth",
    fetch: f,
    token: async (renew) => {
      if (row.authType !== "oauth") return decrypt(row.secret);
      if (!renew && cached && cached.expiresAt.getTime() - Date.now() > 60_000) return decrypt(cached.token);
      const fresh = await oauthToken(row.clientId ?? "", decrypt(row.secret), f);
      cached = { token: encrypt(fresh.token), expiresAt: fresh.expiresAt };
      await db
        .update(schema.tailscaleTailnet)
        .set({ accessToken: cached.token, tokenExpiresAt: fresh.expiresAt })
        .where(eq(schema.tailscaleTailnet.id, row.id))
        .catch(() => {});
      return fresh.token;
    },
  });
}

/** Remembers whether the last API call of a tailnet worked (shown on its card). */
export async function recordTailnetCheck(id: string, error: string | null, devices?: TailscaleDevice[]) {
  const suffix = devices?.map((d) => dnsSuffixOf(d.name)).find(Boolean);
  await db
    .update(schema.tailscaleTailnet)
    .set({ error, checkedAt: new Date(), ...(suffix ? { dnsSuffix: suffix } : {}) })
    .where(eq(schema.tailscaleTailnet.id, id))
    .catch(() => {});
}

export const findByNodeKey = (devices: TailscaleDevice[], nodeKey: string | null | undefined) => (nodeKey ? (devices.find((d) => d.nodeKey === nodeKey) ?? null) : null);

/** What Serve keeps about a device of a server. */
export function deviceFields(d: TailscaleDevice): Pick<ServerTailscale, "deviceId" | "nodeKey" | "address" | "dnsName" | "online" | "lastSeen" | "checkedAt" | "error"> {
  return {
    deviceId: d.id,
    nodeKey: d.nodeKey ?? null,
    address: tailnetIpv4(d),
    dnsName: d.name?.replace(/\.$/, "") || null,
    online: deviceOnline(d),
    lastSeen: d.lastSeen ?? null,
    checkedAt: new Date().toISOString(),
    error: null,
  };
}

/** A server's Tailscale state before it joined. */
export function pendingTailscale(input: { tailnetId: string; hostname: string; only: boolean; tokenHash: string | null; tokenExpiresAt: string | null }): ServerTailscale {
  return {
    ...input,
    authKeyId: null,
    deviceId: null,
    nodeKey: null,
    address: null,
    dnsName: null,
    joinedAt: null,
    online: null,
    lastSeen: null,
    checkedAt: null,
    error: null,
  };
}

/**
 * Where Serve opens SSH to a server that uses the tailnet: its Tailscale address, or null when it
 * does not use one (its host or tunnel then). Throws when the tailnet is its only way in and that
 * way is gone or not there yet, so the reason shows instead of a timeout.
 */
export function tailnetRoute(row: Pick<ServerRow, "name" | "port" | "tailscale">): { host: string; port: number } | null {
  const ts = row.tailscale;
  if (!ts) return null;
  if (ts.tailnetId && ts.address) return { host: ts.address, port: row.port };
  if (!ts.only) return null;
  if (!ts.tailnetId)
    throw new Error(
      `${row.name} is reached only through Tailscale, and the Tailscale integration was removed. Connect the tailnet again in Integrations, Tailscale, then connect the server through it on its page.`,
    );
  throw new Error(`${row.name} has not joined the tailnet yet. Run its join command on the machine.`);
}

/** Whether a TCP port answers, within `ms`. */
export function tcpProbe(host: string, port: number, ms = 4000): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result: { ok: true } | { ok: false; error: string }) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(ms, () => done({ ok: false, error: `no answer within ${Math.round(ms / 1000)} seconds` }));
    socket.once("connect", () => done({ ok: true }));
    socket.once("error", (e: NodeJS.ErrnoException) => done({ ok: false, error: e.code ?? e.message }));
  });
}

/** A failed connection looks like the network, not like SSH refusing the key. */
export const looksLikeNetwork = (message: string) => /timed out|timeout|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED|no answer|did not answer/i.test(message);

/**
 * Why the dashboard may not reach a server's Tailscale address: this machine is not in the tailnet,
 * or it is and the address still does not answer (the device is offline, or the policy blocks it).
 */
export async function tailnetReachHint(row: Pick<ServerRow, "tailscale" | "port">): Promise<string | null> {
  const ts = row.tailscale;
  if (!ts?.address || !ts.tailnetId) return null;
  const [local] = await db.select({ tailscale: schema.server.tailscale }).from(schema.server).where(eq(schema.server.isLocal, true));
  if (!local?.tailscale?.address)
    return `As far as Serve knows, the machine this dashboard runs on is not in the tailnet, so it cannot reach ${ts.address}. Use Add this server to the tailnet in Integrations, Tailscale (a machine that is in the tailnet already is only recorded).`;
  if (local.tailscale.tailnetId !== ts.tailnetId)
    return `The machine this dashboard runs on is in another tailnet than this server, so it cannot reach ${ts.address}. Put the server in the same tailnet.`;
  if (ts.online === false) return `The server is offline in the tailnet (Tailscale last saw it ${ts.lastSeen ? new Date(ts.lastSeen).toUTCString() : "never"}).`;
  return `The dashboard's machine is in the tailnet but ${ts.address}:${row.port} does not answer. Check that Tailscale runs on both machines and that the tailnet policy lets the tag reach itself on TCP ${row.port}.`;
}

/** Servers that use (or used) each tailnet. */
export async function serversByTailnet() {
  const rows = await db
    .select({ id: schema.server.id, name: schema.server.name, isLocal: schema.server.isLocal, tailscale: schema.server.tailscale, tunnel: schema.server.tunnel })
    .from(schema.server)
    .where(isNotNull(schema.server.tailscale));
  const map = new Map<string, typeof rows>();
  for (const r of rows) {
    const id = r.tailscale?.tailnetId;
    if (id) map.set(id, [...(map.get(id) ?? []), r]);
  }
  return map;
}

/**
 * Every few minutes: each server's device as the API shows it (address, online, last seen). A
 * device that got a new address is reached there from now on; one removed from the tailnet says so.
 */
export async function syncTailscale() {
  const tailnets = await db.select().from(schema.tailscaleTailnet);
  if (!tailnets.length) return;
  const byTailnet = await serversByTailnet();
  const { forgetServer } = await import("@/server/servers/context");
  let moved = false;
  for (const t of tailnets) {
    let devices: TailscaleDevice[];
    try {
      devices = await clientFor(t).devices();
      await recordTailnetCheck(t.id, null, devices);
    } catch (error) {
      await recordTailnetCheck(t.id, (error as Error).message);
      continue;
    }
    for (const s of byTailnet.get(t.id) ?? []) {
      const ts = s.tailscale!;
      if (!ts.deviceId && !ts.nodeKey) continue;
      const device = devices.find((d) => d.id === ts.deviceId) ?? findByNodeKey(devices, ts.nodeKey);
      const next: ServerTailscale = device
        ? { ...ts, ...deviceFields(device), address: tailnetIpv4(device) ?? ts.address }
        : ts.only
          ? {
              ...ts,
              online: false,
              checkedAt: new Date().toISOString(),
              error: "This device is no longer in the tailnet (removed in the Tailscale admin console, or its key expired). Connect the server through Tailscale again.",
            }
          : {
              // A server that has its own address again goes back to it: the old Tailscale address leads nowhere.
              ...ts,
              address: null,
              online: false,
              checkedAt: new Date().toISOString(),
              error:
                "This device is no longer in the tailnet (removed in the Tailscale admin console, or its key expired). Serve reaches the server at its own address again. Connect it through Tailscale again to use the tailnet.",
            };
      await db.update(schema.server).set({ tailscale: next }).where(eq(schema.server.id, s.id));
      if (next.address !== ts.address) {
        forgetServer(s.id);
        moved = true;
      }
    }
  }
  if (moved) {
    const { enqueue } = await import("@/server/queue");
    await enqueue("mesh.sync", {}, { concurrencyKey: "mesh" }).catch(() => {});
  }
}
