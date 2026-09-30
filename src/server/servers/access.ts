import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LOCAL_SERVER_ID } from "@/server/db/schema";
import { UserError } from "@/server/action";
import { ForbiddenError, type OrgContext, requireOrg } from "@/server/auth";
import { canAddServers, canManageServer, ownerFor, serverAllowsOrg } from "./ownership";

export { canAddServers, canManageServer, ownerFor, serverAllowsOrg };

/** The signed-in admin and a server they manage; throws otherwise. */
export async function requireServerAdmin(serverId: string) {
  const ctx = await requireOrg();
  const [row] = await db.select().from(schema.server).where(eq(schema.server.id, serverId));
  if (!row) throw new UserError("Server not found.");
  if (!canManageServer(ctx, row)) throw new ForbiddenError("Only admins of the organization that owns this server, or Root admins, can change it.");
  return { ctx, row };
}

/** For creating servers, keys and networks. */
export async function requireServerCreator() {
  const ctx = await requireOrg();
  if (!canAddServers(ctx))
    throw new ForbiddenError(ctx.isRoot ? "Only admins of the Root organization can add servers here." : "Only admins of this organization can add servers.");
  return ctx;
}

/** Servers a context manages: every server for Root admins, else the ones its organization owns. */
export async function managedServerIds(ctx: Pick<OrgContext, "isInstanceAdmin" | "isAdmin" | "org">) {
  const rows = await db.select({ id: schema.server.id, ownerOrganizationId: schema.server.ownerOrganizationId }).from(schema.server);
  return rows.filter((r) => canManageServer(ctx, r)).map((r) => r.id);
}

/** Whether an organization brought servers of its own. */
export async function orgHasServers(organizationId: string) {
  const [row] = await db.select({ id: schema.server.id }).from(schema.server).where(eq(schema.server.ownerOrganizationId, organizationId)).limit(1);
  return !!row;
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
      ownerOrganizationId: schema.server.ownerOrganizationId,
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
