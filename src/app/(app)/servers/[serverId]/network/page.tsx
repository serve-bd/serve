import { count, eq, isNull, or, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { meshOverview } from "@/server/mesh";
import { loadServer } from "../_lib/load";
import { MeshView } from "./mesh-view";

export const metadata = { title: "Private network" };

export default async function ServerNetworkPage(props: PageProps<"/servers/[serverId]/network">) {
  const { serverId } = await props.params;
  const { row } = await loadServer(serverId);
  // The live agent report is fetched by the page itself; the first paint never waits on SSH.
  const overview = await meshOverview(serverId, false);
  const [{ outside }] = await db
    .select({ outside: count() })
    .from(schema.server)
    .where(or(isNull(schema.server.mesh), sql`not coalesce((${schema.server.mesh}->>'enabled')::boolean, false)`));
  const [{ services }] = await db.select({ services: count() }).from(schema.service).where(eq(schema.service.serverId, serverId));
  const loopback = /^(localhost|127\.|::1$)/i.test(row.host);
  const suggested = row.mesh?.endpoint ?? row.publicIp ?? (row.isLocal || loopback || row.tunnel ? "" : row.host);
  return (
    <MeshView
      serverId={serverId}
      serverName={row.name}
      ready={row.isLocal || row.status === "ready"}
      initial={overview}
      suggestedEndpoint={suggested}
      behindNat={!!row.tunnel && !row.mesh?.endpoint}
      outside={Math.max(0, outside - (overview.enabled ? 0 : 1))}
      services={services}
    />
  );
}
