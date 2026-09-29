import { sql } from "drizzle-orm";
import { db, schema } from "@/server/db";

/** Ids of the servers in the private network (it may still be starting on some of them). */
export async function meshMemberIds(): Promise<Set<string>> {
  const rows = await db
    .select({ id: schema.server.id })
    .from(schema.server)
    .where(sql`${schema.server.meshIndex} is not null and coalesce((${schema.server.mesh}->>'enabled')::boolean, false)`);
  return new Set(rows.map((r) => r.id));
}

/** Two servers reach each other's private names: the same server, or both in the private network. */
export const privatelyConnected = (members: Set<string>, a: string, b: string) => a === b || (members.has(a) && members.has(b));
