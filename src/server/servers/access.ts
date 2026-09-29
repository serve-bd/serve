import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LOCAL_SERVER_ID } from "@/server/db/schema";
import { UserError } from "@/server/action";

type ServerRow = typeof schema.server.$inferSelect;

export function serverAllowsOrg(server: Pick<ServerRow, "organizationIds">, organizationId: string) {
  return !server.organizationIds || server.organizationIds.includes(organizationId);
}

/** Servers an organization may deploy to, the local server first. */
export async function serversForOrg(organizationId: string) {
  const rows = await db
    .select({
      id: schema.server.id,
      name: schema.server.name,
      host: schema.server.host,
      status: schema.server.status,
      isLocal: schema.server.isLocal,
      organizationIds: schema.server.organizationIds,
    })
    .from(schema.server)
    .orderBy(asc(schema.server.createdAt));
  return rows
    .filter((s) => serverAllowsOrg(s, organizationId))
    .sort((a, b) => Number(b.isLocal) - Number(a.isLocal))
    .map((s) => ({ id: s.id, name: s.name, host: s.host, status: s.status, isLocal: s.isLocal }));
}

/** Validates that an organization can place a service on a server (defaults to the local server). */
export async function resolveServerForOrg(serverId: string | null | undefined, organizationId: string) {
  const id = serverId || LOCAL_SERVER_ID;
  const [server] = await db.select().from(schema.server).where(eq(schema.server.id, id));
  if (!server) throw new UserError("Server not found.");
  if (!serverAllowsOrg(server, organizationId)) throw new UserError(`This organization cannot deploy to ${server.name}.`);
  if (!server.isLocal && server.status !== "ready") {
    throw new UserError(`${server.name} is not ready (${server.status}). Validate it in Servers first.`);
  }
  return server;
}

/** Public IPv4 of a server, used for DNS records and DNS checks. */
export async function serverPublicIp(serverId: string | null | undefined) {
  const { serverAddressing } = await import("@/server/proxy/addressing");
  return (await serverAddressing(serverId)).publicIp;
}
