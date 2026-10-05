import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decrypt, encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { imageExists, LABEL, pullImage } from "@/server/docker/client";
import { connectProxy, envNetworkName } from "@/server/docker/networks";
import { engines } from "@/server/databases/engines";
import { tunnelTargetPort } from "@/lib/database-domains";
import { privateHost } from "@/lib/hostname";
import { tunnelNetworkName } from "@/server/proxy/names";
import { ensureTunnelNetwork } from "@/server/proxy/tunnel-network";
import { getServer } from "@/server/servers/context";
import { Cloudflare } from "./api";
import { getSetting, getSettings, updateSettings } from "@/server/settings";

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

const INSTANCE_LABEL = "serve.instance";

/** This instance's id (created once). Tunnel containers carry it so cleanup never touches another instance's. */
async function instanceId() {
  const s = await getSettings();
  if (s.instanceId) return s.instanceId;
  const id = newId();
  await updateSettings({ instanceId: id });
  return id;
}

/** Cloudflare's account id for a connected account (looked up once, then stored). */
export async function cfAccountIdOf(accountId: string) {
  const [row] = await db.select().from(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.id, accountId));
  if (!row) throw new Error("Cloudflare account not found.");
  if (row.cfAccountId) return row.cfAccountId;
  const cf = await Cloudflare.forRow(row);
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
export async function ensureTunnelContainer(tunnel: Tunnel, retry = true): Promise<void> {
  const ctx = await getServer(tunnel.serverId);
  const name = tunnelContainerName(tunnel);
  const container = ctx.docker.getContainer(name);
  const { network, created } = await connectorNetwork(ctx);
  let existing = await container.inspect().catch(() => null);
  // Connectors from before the tunnel network sat on the network services share: move them.
  const moved = !!existing && existing.HostConfig.NetworkMode !== network;
  if (moved) {
    await container.remove({ force: true }).catch(() => {});
    existing = null;
  }
  if (created || moved) {
    // The proxy trusts visitor IPs from the tunnel network's subnet: write that trust and every site now, not at the next restart.
    const { syncServerProxy } = await import("@/server/proxy/nginx");
    await syncServerProxy(ctx).catch(() => {});
  }
  if (!existing) {
    if (!(await imageExists(TUNNEL_IMAGE, ctx.docker))) await pullImage(TUNNEL_IMAGE, undefined, null, ctx.docker);
    // The worker and a "Create tunnel" click can get here at the same time: the other one's container is fine.
    await ctx.docker.createContainer(await connectorSpec(tunnel, name, network)).catch((error) => {
      if ((error as { statusCode?: number }).statusCode !== 409) throw error;
    });
    // Docker holds the name before the other one's container can be inspected: wait for it a moment.
    for (let i = 0; !existing; i++) {
      existing = await container.inspect().catch((error) => {
        if (i >= 20) throw error;
        return null;
      });
      if (!existing) await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (existing.State.Running) return;
  try {
    await container.start();
  } catch (error) {
    // 304: started by someone else meanwhile.
    if ((error as { statusCode?: number }).statusCode === 304) return;
    if (!retry) throw error;
    // A container that cannot start (its network was removed, say) is made again once.
    await container.remove({ force: true }).catch(() => {});
    await ensureTunnelContainer(tunnel, false);
  }
}

/**
 * The network connectors join: the one only they share with the proxy, or the main network when it
 * cannot be created (the tunnel still works; the proxy then trusts no tunnel visitor IP).
 */
async function connectorNetwork(ctx: Awaited<ReturnType<typeof getServer>>) {
  const state = await ensureTunnelNetwork(ctx.docker, ctx.network);
  // On the shared network, a tunnel's ingress (edited in Cloudflare) could reach other organizations' containers.
  if (!state) throw new Error("The tunnel network could not be created on this server.");
  const network = tunnelNetworkName(ctx.network);
  await connectProxy(network, ctx);
  return { network, created: state === "created" };
}

async function connectorSpec(tunnel: Tunnel, name: string, network: string) {
  return {
    name,
    Image: TUNNEL_IMAGE,
    // The token stays out of the command line (and `docker ps`).
    Env: [`TUNNEL_TOKEN=${decrypt(tunnel.token)}`],
    Cmd: ["tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:2000", "run"],
    Labels: { [LABEL.managed]: "true", [LABEL.kind]: "tunnel", "serve.tunnel": tunnel.id, [INSTANCE_LABEL]: await instanceId() },
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      NetworkMode: network,
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
    },
  };
}

export type ConnectorUpdate = {
  /** Newer image published for the connector's tag. */
  available: boolean;
  /** Pulled already, but the running container still uses the old image. */
  pulled: boolean;
  latestVersion: string | null;
  error: string | null;
};

const latestRelease = { at: 0, version: null as string | null };

/** Latest cloudflared release tag (cached for an hour). Only used for display. */
async function latestConnectorVersion() {
  if (Date.now() - latestRelease.at < 3600_000) return latestRelease.version;
  const res = await fetch("https://api.github.com/repos/cloudflare/cloudflared/releases/latest", {
    headers: { accept: "application/vnd.github+json", "user-agent": "serve" },
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  const tag = res?.ok ? ((await res.json()) as { tag_name?: string }).tag_name : null;
  latestRelease.at = Date.now();
  latestRelease.version = tag ?? null;
  return latestRelease.version;
}

/** Whether the connector runs the newest image of its tag: the registry's digest against the local image and container. */
export async function connectorUpdate(tunnel: Tunnel, containerImageId: string | null): Promise<ConnectorUpdate> {
  const ctx = await getServer(tunnel.serverId);
  const [remote, local, latestVersion] = await Promise.all([
    (ctx.docker.getImage(TUNNEL_IMAGE).distribution() as Promise<{ Descriptor: { digest: string } }>).then((d) => d.Descriptor.digest),
    ctx.docker
      .getImage(TUNNEL_IMAGE)
      .inspect()
      .catch(() => null),
    latestConnectorVersion(),
  ]).catch((e: Error) => [null, null, null, e] as const);
  if (!remote) return { available: false, pulled: false, latestVersion: null, error: "Could not reach the image registry." };
  const localDigests = (local?.RepoDigests ?? []).map((d) => d.split("@")[1]);
  const pulled = !!local && localDigests.includes(remote) && !!containerImageId && containerImageId !== local.Id;
  return { available: !localDigests.includes(remote) || pulled, pulled, latestVersion, error: null };
}

/**
 * Update the connector without dropping traffic: pull the new image, start a second
 * connector next to the old one (a tunnel accepts several), wait until it has
 * registered with Cloudflare, then remove the old one and take over its name.
 */
export async function updateTunnelConnector(tunnel: Tunnel) {
  const ctx = await getServer(tunnel.serverId);
  const name = tunnelContainerName(tunnel);
  const next = `${name}-next`;
  await pullImage(TUNNEL_IMAGE, undefined, null, ctx.docker);
  await ctx.docker
    .getContainer(next)
    .remove({ force: true })
    .catch(() => {});
  const { network } = await connectorNetwork(ctx);
  const container = await ctx.docker.createContainer(await connectorSpec(tunnel, next, network));
  await container.start();
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const info = await container.inspect();
    if (!info.State.Running) break;
    const logs = (await container.logs({ stdout: true, stderr: true, tail: 200 })).toString("utf8");
    ready = /Registered tunnel connection/i.test(logs);
  }
  if (!ready) {
    const logs = (await container.logs({ stdout: true, stderr: true, tail: 20 }).catch(() => Buffer.from(""))).toString("utf8");
    await container.remove({ force: true }).catch(() => {});
    throw new Error(`The new connector did not connect to Cloudflare within a minute. The old one keeps running.${logs ? `\n${logs.slice(-600)}` : ""}`);
  }
  await ctx.docker
    .getContainer(name)
    .remove({ force: true })
    .catch(() => {});
  // The worker may have recreated the connector in the moment between: keep that one then.
  await container.rename({ name }).catch(async () => {
    const other = await ctx.docker
      .getContainer(name)
      .inspect()
      .catch(() => null);
    if (other?.State.Running) await container.remove({ force: true });
    else throw new Error("The new connector runs, but could not take over its name. Restart the connector.");
  });
  await db.update(schema.cloudflareTunnel).set({ status: "pending", statusMessage: "Connector updated" }).where(eq(schema.cloudflareTunnel.id, tunnel.id));
}

async function removeTunnelContainer(tunnel: Tunnel) {
  // An unreachable server must not hold up deleting the tunnel on Cloudflare, which stops the connector anyway.
  const remove = async () => {
    const ctx = await getServer(tunnel.serverId).catch(() => null);
    await ctx?.docker
      .getContainer(tunnelContainerName(tunnel))
      .remove({ force: true })
      .catch(() => {});
  };
  await Promise.race([remove(), new Promise((r) => setTimeout(r, 20_000))]);
}

/**
 * Databases whose domain goes through this tunnel: the connector joins their networks so it
 * reaches them, and each gets a TCP route to its container.
 */
export async function attachTunnelToDatabases(tunnel: Tunnel) {
  const rows = await db
    .select()
    .from(schema.service)
    .where(
      and(
        eq(schema.service.type, "database"),
        sql`(${schema.service.database}->>'domainTunnelId' = ${tunnel.id} OR ${schema.service.database}->'pooler'->'public'->>'tunnelId' = ${tunnel.id})`,
      ),
    );
  const ctx = await getServer(tunnel.serverId);
  const routes: { hostname: string; service: string }[] = [];
  for (const s of rows) {
    const cfg = s.database;
    if (!cfg) continue;
    const join = () => connectProxy(envNetworkName(s.environmentId), { docker: ctx.docker, proxyContainer: tunnelContainerName(tunnel), id: ctx.id }).catch(() => {});
    if (cfg.domain && cfg.domainTunnelId === tunnel.id) {
      await join();
      const port = tunnelTargetPort(cfg.engine, engines[cfg.engine].port);
      routes.push({ hostname: cfg.domain, service: `tcp://${privateHost(s)}:${port}` });
    }
    // A pooler with its domain on this tunnel: TCP to the pooler.
    const pooler = cfg.pooler?.enabled ? cfg.pooler.public : null;
    if (pooler?.domain && pooler.tunnelId === tunnel.id) {
      await join();
      routes.push({ hostname: pooler.domain, service: `tcp://${privateHost(s)}-pooler:5432` });
    }
  }
  return routes;
}

/** Push the tunnel's routes: every domain on it goes to the server's proxy. */
export async function syncTunnelIngress(tunnelId: string) {
  const [tunnel] = await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.id, tunnelId));
  if (!tunnel) return;
  const ctx = await getServer(tunnel.serverId);
  const domains = await db.select({ hostname: schema.domain.hostname }).from(schema.domain).where(eq(schema.domain.tunnelId, tunnelId));
  // The dashboard can use a tunnel of the server Serve runs on, like any service domain.
  const settings = await getSettings();
  if (settings.dashboardTunnelId === tunnelId && settings.dashboardDomain) domains.push({ hostname: settings.dashboardDomain });
  // Status pages with their own domain on this tunnel: the dashboard's proxy serves them too.
  const pages = await db.select({ hostname: schema.statusPage.domain }).from(schema.statusPage).where(eq(schema.statusPage.tunnelId, tunnelId));
  for (const p of pages) if (p.hostname) domains.push({ hostname: p.hostname });
  const origin = `http://${ctx.proxyContainer}:80`;
  const databases = await attachTunnelToDatabases(tunnel);
  const cf = await Cloudflare.forAccount(tunnel.cloudflareAccountId);
  try {
    await cf.setTunnelIngress(await cfAccountIdOf(tunnel.cloudflareAccountId), tunnel.cfTunnelId, [
      ...domains.map((d) => ({ hostname: d.hostname, service: origin })),
      // Databases on the tunnel: raw TCP straight to their container.
      ...databases,
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
  if (existing) {
    if (existing.status !== "error") return existing;
    // A tunnel whose setup failed before: try the setup again instead of reporting success.
    await syncTunnelIngress(existing.id);
    await ensureTunnelContainer(existing);
    await db.update(schema.cloudflareTunnel).set({ status: "pending", statusMessage: null }).where(eq(schema.cloudflareTunnel.id, existing.id));
    return { ...existing, status: "pending" as const, statusMessage: null };
  }
  const ctx = await getServer(opts.serverId);
  const accountId = await cfAccountIdOf(opts.cloudflareAccountId);
  const cf = await Cloudflare.forAccount(opts.cloudflareAccountId);
  const id = newId();
  const name = `serve-${ctx.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 30)}-${id.slice(0, 6)}`;
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
    .values({
      id,
      organizationId: opts.organizationId,
      cloudflareAccountId: opts.cloudflareAccountId,
      serverId: opts.serverId,
      cfTunnelId: cfTunnel.id,
      name,
      token: encrypt(token),
    })
    .onConflictDoNothing()
    .returning();
  if (!tunnel) {
    // Someone created the tunnel for this server at the same moment: keep theirs, delete ours on Cloudflare.
    await cf.deleteTunnel(accountId, cfTunnel.id).catch(() => {});
    const [theirs] = await db
      .select()
      .from(schema.cloudflareTunnel)
      .where(and(eq(schema.cloudflareTunnel.serverId, opts.serverId), eq(schema.cloudflareTunnel.cloudflareAccountId, opts.cloudflareAccountId)));
    if (!theirs) throw new Error("The tunnel could not be saved. Try again.");
    return theirs;
  }
  try {
    await syncTunnelIngress(tunnel.id);
    await ensureTunnelContainer(tunnel);
  } catch (error) {
    await db
      .update(schema.cloudflareTunnel)
      .set({ status: "error", statusMessage: (error as Error).message })
      .where(eq(schema.cloudflareTunnel.id, id));
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
  // Domains keep wants_tunnel (the foreign key only clears tunnel_id); the dashboard keeps its intent too.
  const settings = await getSettings();
  if (settings.dashboardTunnelId === tunnelId) {
    await updateSettings({ dashboardTunnelId: null, dashboardWantsTunnel: true });
    const { enqueue } = await import("@/server/queue");
    await enqueue("proxy.sync", {}).catch(() => {});
  }
}

/** Read one tunnel's status from Cloudflare and store it. */
export async function refreshTunnelStatus(tunnel: Tunnel) {
  try {
    const cf = await Cloudflare.forAccount(tunnel.cloudflareAccountId);
    const info = await cf.tunnel(await cfAccountIdOf(tunnel.cloudflareAccountId), tunnel.cfTunnelId);
    const status = (["healthy", "degraded", "down"].includes(info.status) ? info.status : "pending") as Tunnel["status"];
    const colos = [...new Set((info.connections ?? []).map((c) => c.colo_name))];
    const statusMessage = colos.length ? `Connected through ${colos.join(", ")}` : status === "down" ? "No connector is running" : null;
    await db.update(schema.cloudflareTunnel).set({ status, statusMessage }).where(eq(schema.cloudflareTunnel.id, tunnel.id));
    return status;
  } catch (error) {
    await db
      .update(schema.cloudflareTunnel)
      .set({ status: "error", statusMessage: (error as Error).message.slice(0, 300) })
      .where(eq(schema.cloudflareTunnel.id, tunnel.id));
    return "error" as const;
  }
}

/** Refresh status from Cloudflare and keep connectors running. Called by the worker. */
export async function checkTunnels() {
  const tunnels = await db.select().from(schema.cloudflareTunnel);
  for (const tunnel of tunnels) {
    try {
      await ensureTunnelContainer(tunnel);
    } catch (error) {
      await db
        .update(schema.cloudflareTunnel)
        .set({ status: "error", statusMessage: (error as Error).message.slice(0, 300) })
        .where(eq(schema.cloudflareTunnel.id, tunnel.id));
      continue;
    }
    await refreshTunnelStatus(tunnel);
    // Domains waiting for a tunnel on this server (its tunnel was removed, or the service moved here).
    // Ones that failed before are left for a manual Reconnect, so a broken record is not retried every minute.
    if (await hasReattachCandidates(tunnel.serverId, tunnel.organizationId)) await reattachTunnelDomains(tunnel, { skipFailed: true }).catch(() => {});
  }
  await removeOrphanTunnelContainers();
}

/* ------------------------------ Reconnecting ------------------------------ */

type DomainRow = typeof schema.domain.$inferSelect;

/** Domains of a server that want a tunnel but have none: the ones a new tunnel should pick up. */
export function reattachCandidates<D extends Pick<DomainRow, "id" | "wantsTunnel" | "tunnelId" | "hostname" | "tunnelError"> & { serverId: string }>(
  domains: D[],
  serverId: string,
  opts: { skipFailed?: boolean; domainId?: string } = {},
): D[] {
  return domains.filter(
    (d) =>
      d.wantsTunnel && !d.tunnelId && d.serverId === serverId && !d.hostname.startsWith("*.") && !(opts.skipFailed && d.tunnelError) && (!opts.domainId || d.id === opts.domainId),
  );
}

/** Waiting domains of one organization's services on a server (servers can be shared by organizations). */
async function waitingDomains(serverId: string, organizationId: string) {
  return db
    .select({ domain: schema.domain, serverId: schema.service.serverId })
    .from(schema.domain)
    .innerJoin(schema.service, eq(schema.domain.serviceId, schema.service.id))
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(and(eq(schema.domain.wantsTunnel, true), isNull(schema.domain.tunnelId), eq(schema.service.serverId, serverId), eq(schema.project.organizationId, organizationId)));
}

/** The dashboard wants a tunnel on the local server but has none (or its tunnel is gone). */
async function dashboardWaiting() {
  const s = await getSettings();
  if (!s.dashboardDomain || !(s.dashboardWantsTunnel || s.dashboardTunnelId)) return null;
  if (s.dashboardTunnelId) {
    const [t] = await db.select({ id: schema.cloudflareTunnel.id }).from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.id, s.dashboardTunnelId));
    if (t) return null;
  }
  return s.dashboardDomain;
}

async function hasReattachCandidates(serverId: string, organizationId: string) {
  const rows = await waitingDomains(serverId, organizationId);
  if (
    reattachCandidates(
      rows.map((r) => ({ ...r.domain, serverId: r.serverId })),
      serverId,
      { skipFailed: true },
    ).length
  )
    return true;
  const [server] = await db.select({ isLocal: schema.server.isLocal }).from(schema.server).where(eq(schema.server.id, serverId));
  return !!server?.isLocal && !!(await dashboardWaiting());
}

export type ReattachResult = { reconnected: string[]; failed: { hostname: string; error: string }[]; notInAccount: string[] };

/**
 * Point waiting domains of the tunnel's server at the tunnel: DNS record, route and proxy.
 * Domains outside the tunnel's Cloudflare account are left alone (another tunnel may own them).
 * One domain failing never stops the others; its error is stored and shown.
 */
export async function reattachTunnelDomains(tunnel: Tunnel, opts: { skipFailed?: boolean; domainId?: string } = {}): Promise<ReattachResult> {
  const result: ReattachResult = { reconnected: [], failed: [], notInAccount: [] };
  const rows = await waitingDomains(tunnel.serverId, tunnel.organizationId);
  const candidates = reattachCandidates(
    rows.map((r) => ({ ...r.domain, serverId: r.serverId })),
    tunnel.serverId,
    opts,
  );
  const cf = await Cloudflare.forAccount(tunnel.cloudflareAccountId);
  const services = new Set<string>();
  for (const d of candidates) {
    const zone = await cf.zoneFor(d.hostname).catch(() => null);
    if (!zone) {
      result.notInAccount.push(d.hostname);
      continue;
    }
    try {
      const record = await cf.upsertTunnelRecord(zone.id, d.hostname, tunnel.cfTunnelId);
      await db
        .update(schema.domain)
        .set({
          tunnelId: tunnel.id,
          https: false,
          forceHttps: false,
          cloudflareAccountId: tunnel.cloudflareAccountId,
          cloudflareZoneId: zone.id,
          cloudflareRecordId: record.id,
          tunnelError: null,
        })
        .where(eq(schema.domain.id, d.id));
      result.reconnected.push(d.hostname);
      services.add(d.serviceId);
    } catch (error) {
      const message = (error as Error).message.slice(0, 300);
      await db.update(schema.domain).set({ tunnelError: message }).where(eq(schema.domain.id, d.id));
      result.failed.push({ hostname: d.hostname, error: message });
    }
  }

  const [server] = await db.select({ isLocal: schema.server.isLocal }).from(schema.server).where(eq(schema.server.id, tunnel.serverId));
  // The dashboard's domain belongs to the instance: only a tunnel of the Root organization carries it.
  const root = await getSetting("rootOrganizationId");
  const dashboard = !opts.domainId && server?.isLocal && tunnel.organizationId === root ? await dashboardWaiting() : null;
  if (dashboard) {
    const zone = await cf.zoneFor(dashboard).catch(() => null);
    if (zone) {
      try {
        await cf.upsertTunnelRecord(zone.id, dashboard, tunnel.cfTunnelId);
        await updateSettings({ dashboardTunnelId: tunnel.id, dashboardWantsTunnel: true, dashboardHttps: false });
        result.reconnected.push(`${dashboard} (dashboard)`);
        const { enqueue } = await import("@/server/queue");
        await enqueue("proxy.sync", {}).catch(() => {});
      } catch (error) {
        result.failed.push({ hostname: `${dashboard} (dashboard)`, error: (error as Error).message.slice(0, 300) });
      }
    }
  }

  if (result.reconnected.length) {
    await syncTunnelIngress(tunnel.id);
    const { syncServiceProxy } = await import("@/server/proxy/nginx");
    for (const id of services) await syncServiceProxy(id).catch(() => {});
  }
  return result;
}

/** Try every tunnel of a server (a domain belongs to whichever tunnel's account owns its zone). */
export async function reattachOnServer(serverId: string, opts: { domainId?: string } = {}) {
  const tunnels = await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.serverId, serverId));
  const total: ReattachResult = { reconnected: [], failed: [], notInAccount: [] };
  for (const t of tunnels) {
    const r = await reattachTunnelDomains(t, opts);
    total.reconnected.push(...r.reconnected);
    total.failed.push(...r.failed);
    total.notInAccount.push(...r.notInAccount);
  }
  // Only "not in any account" once no tunnel took the domain.
  total.notInAccount = [...new Set(total.notInAccount)].filter((h) => !total.reconnected.includes(h));
  return { ...total, tunnels: tunnels.length };
}

/**
 * Connectors whose tunnel no longer exists (for example after its Cloudflare account was
 * disconnected) would keep serving traffic. Only containers on this instance's network are
 * touched, so a second Serve instance on the same Docker engine keeps its own.
 */
async function removeOrphanTunnelContainers() {
  const me = await instanceId();
  const servers = await db.select({ id: schema.server.id }).from(schema.server);
  for (const { id } of servers) {
    const ctx = await getServer(id).catch(() => null);
    if (!ctx) continue;
    const containers = await ctx.docker.listContainers({ all: true, filters: { label: [`${LABEL.kind}=tunnel`] } }).catch(() => []);
    // Read the tunnels right before deciding: one created while this loop ran is not an orphan.
    const known = new Set((await db.select({ id: schema.cloudflareTunnel.id }).from(schema.cloudflareTunnel)).map((t) => t.id));
    for (const c of containers) {
      const tunnelId = c.Labels["serve.tunnel"];
      if (!tunnelId || known.has(tunnelId)) continue;
      const owner = c.Labels[INSTANCE_LABEL];
      // Ours by label; containers from before the label only when they sit on this instance's network.
      if (owner ? owner !== me : c.HostConfig?.NetworkMode !== ctx.network) continue;
      await ctx.docker
        .getContainer(c.Id)
        .remove({ force: true })
        .catch(() => {});
    }
  }
}

/* ------------------------------ Details ------------------------------ */

export type TunnelDetails = {
  cloudflare:
    | {
        ok: true;
        status: string;
        createdAt: string | null;
        activeAt: string | null;
        inactiveAt: string | null;
        connections: { id: string; colo: string; originIp: string | null; openedAt: string | null; version: string | null; pending: boolean }[];
      }
    | { ok: false; error: string };
  connector:
    | { ok: true; exists: false }
    | {
        ok: true;
        exists: true;
        state: string;
        running: boolean;
        startedAt: string | null;
        image: string;
        restarts: number;
        error: string | null;
        imageId: string;
        update: ConnectorUpdate | null;
      }
    | { ok: false; error: string };
};

function withTimeout<T>(promise: Promise<T>, ms: number, what: string) {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not answer in time.`)), ms))]);
}

/** Live details of one tunnel: its connections as Cloudflare sees them, and its connector container. */
export async function tunnelDetails(tunnel: Tunnel): Promise<TunnelDetails> {
  const [cloudflare, connector] = await Promise.all([
    withTimeout(
      (async () => {
        const cf = await Cloudflare.forAccount(tunnel.cloudflareAccountId);
        return cf.tunnel(await cfAccountIdOf(tunnel.cloudflareAccountId), tunnel.cfTunnelId);
      })(),
      8000,
      "Cloudflare",
    ).then(
      (info): TunnelDetails["cloudflare"] => ({
        ok: true,
        status: info.status,
        createdAt: info.created_at ?? null,
        activeAt: info.conns_active_at ?? null,
        inactiveAt: info.conns_inactive_at ?? null,
        connections: (info.connections ?? []).map((c, i) => ({
          id: c.id ?? `${c.colo_name}-${i}`,
          colo: c.colo_name,
          originIp: c.origin_ip ?? null,
          openedAt: c.opened_at ?? null,
          version: c.client_version ?? null,
          pending: c.is_pending_reconnect,
        })),
      }),
      (error): TunnelDetails["cloudflare"] => ({ ok: false, error: tunnelError(error).message }),
    ),
    withTimeout(
      (async () => {
        const ctx = await getServer(tunnel.serverId);
        return ctx.docker
          .getContainer(tunnelContainerName(tunnel))
          .inspect()
          .catch((e: { statusCode?: number }) => {
            if (e?.statusCode === 404) return null;
            throw e;
          });
      })(),
      8000,
      "The server",
    ).then(
      (info): TunnelDetails["connector"] =>
        info
          ? {
              ok: true,
              exists: true,
              state: info.State.Status,
              running: info.State.Running,
              startedAt: info.State.Running && info.State.StartedAt ? info.State.StartedAt : null,
              image: info.Config.Image,
              restarts: info.RestartCount ?? 0,
              error: info.State.Error || null,
              update: null,
              imageId: info.Image,
            }
          : { ok: true, exists: false },
      (error): TunnelDetails["connector"] => ({ ok: false, error: (error as Error).message }),
    ),
  ]);
  if (connector.ok && connector.exists) {
    const update = await withTimeout(connectorUpdate(tunnel, connector.imageId), 8000, "The image registry").catch((e: Error) => ({
      available: false,
      pulled: false,
      latestVersion: null,
      error: e.message,
    }));
    return { cloudflare, connector: { ...connector, update } };
  }
  return { cloudflare, connector };
}

/** Restart the connector container (or create it again when it is missing). */
export async function restartTunnelConnector(tunnel: Tunnel) {
  const ctx = await getServer(tunnel.serverId);
  const container = ctx.docker.getContainer(tunnelContainerName(tunnel));
  const exists = await container
    .inspect()
    .then(() => true)
    .catch(() => false);
  if (exists) await container.restart({ t: 5 });
  else await ensureTunnelContainer(tunnel);
  await db.update(schema.cloudflareTunnel).set({ status: "pending", statusMessage: "Connector restarted" }).where(eq(schema.cloudflareTunnel.id, tunnel.id));
}

/** Domains currently routed through tunnels (for warnings when a tunnel is removed). */
export async function tunnelDomains(tunnelId: string) {
  const settings = await getSettings();
  const dashboard = settings.dashboardTunnelId === tunnelId && settings.dashboardDomain ? [{ id: "dashboard", hostname: `${settings.dashboardDomain} (dashboard)` }] : [];
  const rows = await db
    .select({ id: schema.domain.id, hostname: schema.domain.hostname })
    .from(schema.domain)
    .where(and(eq(schema.domain.tunnelId, tunnelId), isNotNull(schema.domain.tunnelId)));
  return [...dashboard, ...rows];
}

/** Worker tick: tunnels carrying databases rejoin their networks (a recreated connector loses them). */
export async function reattachDatabaseTunnels() {
  const rows = await db
    .selectDistinct({ id: sql<string>`${schema.service.database}->>'domainTunnelId'` })
    .from(schema.service)
    .where(sql`coalesce(${schema.service.database}->>'domainTunnelId', '') <> ''`);
  for (const t of rows) {
    const [tunnel] = await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.id, t.id));
    if (tunnel) await attachTunnelToDatabases(tunnel).catch(() => {});
  }
}
