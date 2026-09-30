import { sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import type { MeshMembers } from "./plan";

/** Servers in the private network (it may still be starting on some), with their networks and whether they have no public address. */
export async function meshMemberIds(): Promise<MeshMembers> {
  const rows = await db
    .select({ id: schema.server.id, mesh: schema.server.mesh })
    .from(schema.server)
    .where(sql`${schema.server.meshIndex} is not null and coalesce((${schema.server.mesh}->>'enabled')::boolean, false)`);
  const links = await db.select().from(schema.privateNetworkMember);
  return new Map(rows.map((r) => [r.id, { networks: links.filter((l) => l.serverId === r.id).map((l) => l.networkId), nat: !r.mesh?.endpoint }]));
}

export { privatelyConnected, reachesPrivately, type MeshMembers } from "./plan";
