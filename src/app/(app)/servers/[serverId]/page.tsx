import { asc, count, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getSettings } from "@/server/settings";
import { hostInfo, serverHealth } from "@/server/system";
import { proxyStatus } from "@/server/proxy/nginx";
import { commandExists } from "@/server/process";
import { fingerprint } from "@/server/servers/ssh";
import { ServerOverview } from "./general";
import { AccessCard, BuildsLimitsCard, ConnectionSettings, DangerZone, ValidationCard, type ServerDetails } from "./server-settings";
import { loadServer, withTimeout } from "./_lib/load";
import { TunnelCard } from "./tunnel-card";

export const metadata = { title: "Server" };

export default async function ServerGeneralPage(props: PageProps<"/servers/[serverId]">) {
  const { serverId } = await props.params;
  const { row, server } = await loadServer(serverId);
  const reachable = row.isLocal || row.status === "ready";

  const [settings, keys, orgs, [{ services }]] = await Promise.all([
    getSettings(),
    db.select({ id: schema.privateKey.id, name: schema.privateKey.name }).from(schema.privateKey).orderBy(asc(schema.privateKey.name)),
    db.select({ id: schema.organization.id, name: schema.organization.name }).from(schema.organization).orderBy(asc(schema.organization.createdAt)),
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
            extra: { nixpacks, dataDir: ctx.paths.root, proxyPorts: `${ctx.proxyHttpPort} / ${ctx.proxyHttpsPort}` },
          };
        }),
      )
    : null;

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
    dataDir: row.dataDir,
    status: row.status,
    statusMessage: row.statusMessage,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    organizationIds: row.organizationIds,
    services,
  };

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
      <BuildsLimitsCard
        serverId={row.id}
        limits={{ buildConcurrency: row.buildConcurrency, imageRetention: row.imageRetention, metricsRetentionHours: row.metricsRetentionHours }}
      />
      <AccessCard server={details} organizations={orgs} />
      {!row.isLocal && <DangerZone server={details} />}
    </>
  );
}
