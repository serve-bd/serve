import { count, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db, schema } from "@/server/db";
import { fingerprint } from "@/server/servers/ssh";
import { DangerZone, type ServerDetails } from "../server-settings";
import { loadServerView } from "../_lib/load";

export const metadata = { title: "Danger zone" };

export default async function DangerPage(props: { params: Promise<{ serverId: string }> }) {
  const { serverId } = await props.params;
  const { row, manage } = await loadServerView(serverId);
  // The machine Serve runs on is never removed; others only by those who manage the server.
  if (!manage || row.isLocal) notFound();
  const [{ services }] = await db.select({ services: count() }).from(schema.service).where(eq(schema.service.serverId, serverId));
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
    tunnelConnected: !!row.tunnel?.connectedAt,
    dataDir: row.dataDir,
    status: row.status,
    statusMessage: row.statusMessage,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    organizationIds: row.organizationIds,
    ownerOrganizationId: row.ownerOrganizationId,
    services,
    tailscaleOnly: !!row.tailscale?.only,
    tailnetDevice: row.tailscale?.deviceId ? (row.tailscale.dnsName ?? row.tailscale.hostname) : null,
  };
  return <DangerZone server={details} />;
}
