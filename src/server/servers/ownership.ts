/** Who owns, manages and deploys to servers. Pure rules; the checks with the database are in ./access. */

type Ctx = { isInstanceAdmin: boolean; isAdmin: boolean; isRoot: boolean; org: { id: string } };
type ServerAccess = { ownerOrganizationId: string | null; organizationIds: string[] | null };

/** The owner deploys to its server; others when a Root admin shared it with them (null: every organization). */
export function serverAllowsOrg(server: ServerAccess, organizationId: string) {
  return server.ownerOrganizationId === organizationId || !server.organizationIds || server.organizationIds.includes(organizationId);
}

/**
 * Who manages a server: Root admins manage every server; admins of the organization that owns
 * a server manage that one. Shared servers are used, not managed, by the other organizations.
 */
export function canManageServer(ctx: Pick<Ctx, "isInstanceAdmin" | "isAdmin" | "org">, server: Pick<ServerAccess, "ownerOrganizationId">) {
  return ctx.isInstanceAdmin || (ctx.isAdmin && !!server.ownerOrganizationId && server.ownerOrganizationId === ctx.org.id);
}

/**
 * Servers listed while an organization is active: in Root, every server a Root admin manages; in
 * any other organization only its own servers, plus (for Root admins) the ones shared with it.
 * Root admins can still open any server; the lists just match the organization they are in.
 */
export function listedInOrg(ctx: Pick<Ctx, "isInstanceAdmin" | "isAdmin" | "isRoot" | "org">, server: ServerAccess) {
  if (ctx.isRoot) return canManageServer(ctx, server);
  if (server.ownerOrganizationId === ctx.org.id) return ctx.isAdmin || ctx.isInstanceAdmin;
  return ctx.isInstanceAdmin && serverAllowsOrg(server, ctx.org.id);
}

/** Admins may add servers and SSH keys: Root admins for the instance (in Root), others for their organization. */
export function canAddServers(ctx: Pick<Ctx, "isInstanceAdmin" | "isAdmin" | "isRoot">) {
  return ctx.isRoot ? ctx.isInstanceAdmin : ctx.isAdmin;
}

/** Owner of servers, keys and networks created in this context: null (the instance) in Root. */
export const ownerFor = (ctx: Pick<Ctx, "isRoot" | "org">) => (ctx.isRoot ? null : ctx.org.id);
