import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { sha256 } from "@/server/crypto";
import { tokenGrants } from "@/lib/api-scopes";
import type { Permission } from "@/lib/permissions";
import { memberAccess } from "@/server/permissions";
import { dashboardVisitorIp } from "@/server/proxy/trusted-proxies";
import type { ApiPrincipal } from "@/server/api/principal";

export type ApiAuth = ApiPrincipal & {
  canAccessProject: (projectId: string) => boolean;
  can: (permission: Permission) => boolean;
};

const USAGE_INTERVAL = 60_000;

const json = (status: number, error: string) => Response.json({ error }, { status });

/**
 * Authenticate a bearer API token. Its permissions are the ones it was given that its owner's
 * role still has right now: a role change or removal applies at once. Returns the auth context
 * or a ready error response.
 */
export async function authenticateToken(request: Request): Promise<{ auth: ApiAuth; error?: never } | { auth?: never; error: Response }> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token.startsWith("srv_")) return { error: json(401, "Invalid or missing API token") };
  const [row] = await db
    .select()
    .from(schema.apiToken)
    .where(eq(schema.apiToken.tokenHash, sha256(token)));
  if (!row) return { error: json(401, "Invalid or missing API token") };
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return { error: json(401, "Token expired") };

  const owner = await memberAccess(row.organizationId, row.userId);
  if (!owner) return { error: json(401, "The owner of this token is no longer a member of the organization") };
  const granted = tokenGrants(row.scopes);
  const ownerAdmin = owner.roleId === "owner" || owner.roleId === "admin";
  const permissions = new Set([...granted.permissions].filter((p) => owner.permissions.has(p)));

  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > USAGE_INTERVAL) {
    void db
      .update(schema.apiToken)
      .set({ lastUsedAt: new Date(), lastUsedIp: await dashboardVisitorIp(request.headers) })
      .where(eq(schema.apiToken.id, row.id))
      .catch(() => {});
  }

  const tokenProjects = row.projectIds?.length ? row.projectIds : null;
  // Both the token and its owner limit the projects; the stricter one wins.
  const projectIds = !owner.projectIds ? tokenProjects : !tokenProjects ? owner.projectIds : tokenProjects.filter((id) => owner.projectIds!.includes(id));
  return {
    auth: {
      tokenId: row.id,
      organizationId: row.organizationId,
      userId: row.userId,
      permissions,
      admin: granted.admin && ownerAdmin,
      projectIds,
      canAccessProject: (projectId) => !projectIds || projectIds.includes(projectId),
      can: (p) => permissions.has(p),
    },
  };
}

export const notFound = (what = "Not found") => json(404, what);
