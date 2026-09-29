import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decrypt, encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { imageExists, LABEL, pullImage } from "@/server/docker/client";
import { getServer } from "@/server/servers/context";
import { Cloudflare } from "./api";

/**
 * Cloudflare Tunnels: a cloudflared container on a server keeps an outbound
 * connection to Cloudflare, and Cloudflare sends the tunnel's hostnames
 * through it to the server's nginx proxy. No public IP or open ports needed.
 */

export const TUNNEL_IMAGE = process.env.SERVE_TUNNEL_IMAGE ?? "cloudflare/cloudflared:latest";

type Tunnel = typeof schema.cloudflareTunnel.$inferSelect;

export function tunnelContainerName(tunnel: Pick<Tunnel, "id">) {
  return `serve-tunnel-${tunnel.id}`;
}

/** Cloudflare's account id for a connected account (looked up once, then stored). */
export async function cfAccountIdOf(accountId: string) {
  const [row] = await db.select().from(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.id, accountId));
  if (!row) throw new Error("Cloudflare account not found.");
  if (row.cfAccountId) return row.cfAccountId;
  const cf = new Cloudflare(decrypt(row.apiToken));
  const id = (await cf.accounts())[0]?.id ?? (await cf.zones())[0]?.account?.id;
  if (!id) throw new Error("This Cloudflare token cannot see any account. Give it Account · Cloudflare Tunnel · Edit.");
  await db.update(schema.cloudflareAccount).set({ cfAccountId: id }).where(eq(schema.cloudflareAccount.id, accountId));
  return id;
}

function tunnelError(error: unknown) {
  const message = (error as Error).message;
  if (/authentication|not authorized|permission|10000|code: 9109/i.test(message)) {
    return new Error("Cloudflare refused the request. The API token needs Account · Cloudflare Tunnel · Edit (and Zone · DNS · Edit).");
  }
  return error instanceof Error ? error : new Error(message);
}

/** Start (or repair) the cloudflared container for a tunnel on its server. */
export async function ensureTunnelContainer(tunnel: Tunnel) {
  const ctx = await getServer(tunnel.serverId);
  const name = tunnelContainerName(tunnel);
  const existing = await ctx.docker.getContainer(name).inspect().catch(() => null);
  if (existing?.State.Running) return;
  if (existing) {
    await ctx.docker.getContainer(name).start().catch(async () => {
      await ctx.docker.getContainer(name).remove({ force: true });
      await ensureTunnelContainer(tunnel);
    });
    return;
  }
  if (!(await imageExists(TUNNEL_IMAGE, ctx.docker))) await pullImage(TUNNEL_IMAGE, undefined, null, ctx.docker);
  const container = await ctx.docker.createContainer({
    name,
    Image: TUNNEL_IMAGE,
    // The token stays out of the command line (and `docker ps`).
    Env: [`TUNNEL_TOKEN=${decrypt(tunnel.token)}`],
    Cmd: ["tunnel", "--no-autoupdate", "--metrics", "0.0.0.0:2000", "run"],
    Labels: { [LABEL.managed]: "true", [LABEL.kind]: "tunnel", "serve.tunnel": tunnel.id },
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      NetworkMode: ctx.network,
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
    },
  });
  await container.start();
}

async function removeTunnelContainer(tunnel: Tunnel) {
  const ctx = await getServer(tunnel.serverId).catch(() => null);
  if (!ctx) return;
  await ctx.docker.getContainer(tunnelContainerName(tunnel)).remove({ force: true }).catch(() => {});
}

/** Push the tunnel's routes: every domain on it goes to the server's proxy. */
export async function syncTunnelIngress(tunnelId: string) {
  const [tunnel] = await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.id, tunnelId));
  if (!tunnel) return;
  const ctx = await getServer(tunnel.serverId);
  const domains = await db.select({ hostname: schema.domain.hostname }).from(schema.domain).where(eq(schema.domain.tunnelId, tunnelId));
  const origin = `http://${ctx.proxyContainer}:80`;
  const cf = await Cloudflare.forAccount(tunnel.cloudflareAccountId);
  try {
    await cf.setTunnelIngress(await cfAccountIdOf(tunnel.cloudflareAccountId), tunnel.cfTunnelId, [
      ...domains.map((d) => ({ hostname: d.hostname, service: origin })),
      { service: "http_status:404" },
    ]);
  } catch (error) {
    throw tunnelError(error);
  }
}

/** Create a tunnel for a server and Cloudflare account and start its connector. */
export async function createTunnel(opts: { organizationId: string; cloudflareAccountId: string; serverId: string }) {
  const [existing] = await db
    .select()
    .from(schema.cloudflareTunnel)
    .where(and(eq(schema.cloudflareTunnel.serverId, opts.serverId), eq(schema.cloudflareTunnel.cloudflareAccountId, opts.cloudflareAccountId)));
  if (existing) return existing;
  const ctx = await getServer(opts.serverId);
  const accountId = await cfAccountIdOf(opts.cloudflareAccountId);
  const cf = await Cloudflare.forAccount(opts.cloudflareAccountId);
  const id = newId();
  const name = `serve-${ctx.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}-${id.slice(0, 6)}`;
  let cfTunnel;
  let token: string;
  try {
    cfTunnel = await cf.createTunnel(accountId, name);
    token = cfTunnel.token ?? (await cf.tunnelToken(accountId, cfTunnel.id));
  } catch (error) {
    throw tunnelError(error);
  }
  const [tunnel] = await db
    .insert(schema.cloudflareTunnel)
    .values({ id, organizationId: opts.organizationId, cloudflareAccountId: opts.cloudflareAccountId, serverId: opts.serverId, cfTunnelId: cfTunnel.id, name, token: encrypt(token) })
    .returning();
  try {
    await syncTunnelIngress(tunnel.id);
    await ensureTunnelContainer(tunnel);
  } catch (error) {
    await db.update(schema.cloudflareTunnel).set({ status: "error", statusMessage: (error as Error).message }).where(eq(schema.cloudflareTunnel.id, id));
    throw error;
  }
  return tunnel;
}

/** Stop the connector and delete the tunnel on Cloudflare. Domains must be moved off it first. */
export async function deleteTunnel(tunnelId: string) {
  const [tunnel] = await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.id, tunnelId));
  if (!tunnel) return;
  await removeTunnelContainer(tunnel);
  try {
    const cf = await Cloudflare.forAccount(tunnel.cloudflareAccountId);
    await cf.deleteTunnel(await cfAccountIdOf(tunnel.cloudflareAccountId), tunnel.cfTunnelId);
  } catch {
    // Already gone on Cloudflare, or the account was disconnected.
  }
  await db.delete(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.id, tunnelId));
}

/** Refresh status from Cloudflare and keep connectors running. Called by the worker. */
export async function checkTunnels() {
  const tunnels = await db.select().from(schema.cloudflareTunnel);
  for (const tunnel of tunnels) {
    try {
      await ensureTunnelContainer(tunnel);
      const cf = await Cloudflare.forAccount(tunnel.cloudflareAccountId);
      const info = await cf.tunnel(await cfAccountIdOf(tunnel.cloudflareAccountId), tunnel.cfTunnelId);
      const status = (["healthy", "degraded", "down"].includes(info.status) ? info.status : "pending") as Tunnel["status"];
      const colos = [...new Set((info.connections ?? []).map((c) => c.colo_name))];
      await db
        .update(schema.cloudflareTunnel)
        .set({ status, statusMessage: colos.length ? `Connected through ${colos.join(", ")}` : status === "down" ? "No connector is running" : null })
        .where(eq(schema.cloudflareTunnel.id, tunnel.id));
    } catch (error) {
      await db.update(schema.cloudflareTunnel).set({ status: "error", statusMessage: (error as Error).message.slice(0, 300) }).where(eq(schema.cloudflareTunnel.id, tunnel.id));
    }
  }
}

/** Domains currently routed through tunnels (for warnings when a tunnel is removed). */
export async function tunnelDomains(tunnelId: string) {
  return db
    .select({ id: schema.domain.id, hostname: schema.domain.hostname })
    .from(schema.domain)
    .where(and(eq(schema.domain.tunnelId, tunnelId), isNotNull(schema.domain.tunnelId)));
}
