import { sql } from "drizzle-orm";
import { db, schema } from "@/server/db";

/** Servers in the private network (it may still be starting on some), each with the private networks it is in. */
export async function meshMemberIds(): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ id: schema.server.id })
    .from(schema.server)
    .where(sql`${schema.server.meshIndex} is not null and coalesce((${schema.server.mesh}->>'enabled')::boolean, false)`);
  const links = await db.select().from(schema.privateNetworkMember);
  return new Map(rows.map((r) => [r.id, links.filter((l) => l.serverId === r.id).map((l) => l.networkId)]));
}

export { privatelyConnected } from "./plan";
