import { asc, count, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getSettings } from "@/server/settings";
import { hostInfo, serverHealth } from "@/server/system";
import { proxyStatus } from "@/server/proxy/nginx";
import { commandExists } from "@/server/process";
import { fingerprint } from "@/server/servers/ssh";
import { ServerOverview } from "./general";
import { ConnectionSettings, ValidationCard, type ServerDetails } from "./server-settings";
import { loadServerView, withTimeout } from "./_lib/load";
import { TunnelCard } from "./tunnel-card";
import { TailscaleCard } from "./tailscale-card";
import { tailnetChoices, tailscaleView } from "@/server/tailscale/view";

export const metadata = { title: "Server" };

export default async function ServerGeneralPage(props: PageProps<"/servers/[serverId]">) {
  const { serverId } = await props.params;
  const { row, ctx, server, manage } = await loadServerView(serverId);
  const reachable = row.isLocal || row.status === "ready";

  const [settings, keys, [{ services }]] = await Promise.all([
    getSettings(),
    // Keys of the server's owner (instance keys for instance servers).
    db
      .select({ id: schema.privateKey.id, name: schema.privateKey.name })
      .from(schema.privateKey)
      .where(row.ownerOrganizationId ? eq(schema.privateKey.organizationId, row.ownerOrganizationId) : isNull(schema.privateKey.organizationId))
      .orderBy(asc(schema.privateKey.name)),
    db.select({ services: count() }).from(schema.service).where(eq(schema.service.serverId, serverId)),
  ]);

  const overview = reachable
    ? await withTimeout(
        server().then(async (ctx) => {
          const [host, health, proxy, nixpacks] = await Promise.all([
            hostInfo(ctx),
            serverHealth(ctx, settings),
            proxyStatus(ctx).catch(() => null),
            ctx.local ? commandExists("nixpacks") : Promise.resolve(null),
          ]);
          return {
            host,
            health: { ...health, proxyStartedAt: proxy?.startedAt ?? null },
            extra: {
              nixpacks,
              dataDir: ctx.paths.root,
              proxyPorts: ctx.proxyHttpPort || ctx.proxyHttpsPort ? `${ctx.proxyHttpPort || "off"} / ${ctx.proxyHttpsPort || "off"}` : "None (tunnels only)",
            },
          };
        }),
      )
    : null;

  if (!manage) {
    // Seen read-only: how the machine is doing, nothing about how it is reached or set up.
    return (
      <>
        {overview && <ServerOverview host={overview.host} health={overview.health} extra={{ ...overview.extra, dataDir: null }} />}
        <p className="px-1 text-[13px] leading-relaxed text-muted">
          {ctx.isAdmin
            ? "Your organization deploys here and may add this server to its private networks. Its settings, terminal and cleanup stay with the organization that owns it."
            : "You can see how this server is doing. Admins of your organization choose which services run here."}
        </p>
      </>
    );
  }

  const details: ServerDetails = {
    id: row.id,
    name: row.name,
    description: row.description,
    isLocal: row.isLocal,
    host: row.host,
    port: row.port,
    username: row.username,
    privateKeyId: row.privateKeyId,
    hostKey: row.hostKey,
    hostKeyFingerprint: row.hostKey ? fingerprint(row.hostKey) : null,
    tunnel: !!row.tunnel,
    // Through Tailscale it is reached without its tunnel.
    tunnelConnected: !!row.tunnel?.connectedAt || !!(row.tailscale?.tailnetId && row.tailscale.address),
    dataDir: row.dataDir,
    status: row.status,
    statusMessage: row.statusMessage,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    organizationIds: row.organizationIds,
    ownerOrganizationId: row.ownerOrganizationId,
    services,
    tailscaleOnly: !!row.tailscale?.only,
  };
  // The tailnet is the instance's: Root admins manage it, for the instance's servers.
  const tailnets = ctx.isInstanceAdmin ? await tailnetChoices(row) : [];
  const tailscale = ctx.isInstanceAdmin && (row.tailscale || tailnets.length) ? await tailscaleView(row) : null;

  return (
    <>
      {overview && <ServerOverview host={overview.host} health={overview.health} extra={overview.extra} />}
      {!row.isLocal && <ValidationCard server={details} />}
      {row.tunnel ? (
        <TunnelCard
          serverId={row.id}
          user={row.username}
          sshPort={row.port}
          tunnel={{
            connectedAt: row.tunnel.connectedAt,
            remote: row.tunnel.remote,
            joined: !!row.tunnel.clientKey,
            address: row.tunnel.address,
            port: row.tunnel.port,
            listenerError: settings.tunnelListener?.error ?? null,
          }}
        />
      ) : (
        <ConnectionSettings server={details} keys={keys} />
      )}
      {ctx.isInstanceAdmin && (row.tailscale || tailnets.length > 0) && (
        <TailscaleCard server={{ id: row.id, name: row.name, isLocal: row.isLocal, ready: row.status === "ready", user: row.username }} view={tailscale} tailnets={tailnets} />
      )}
    </>
  );
}
