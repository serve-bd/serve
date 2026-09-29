import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { sha256 } from "@/server/crypto";
import { serviceInOrg } from "@/server/services/access";
import { expandScopes, SCOPE_INFO, type ApiScope } from "@/lib/api-scopes";

export type ApiAuth = {
  tokenId: string;
  organizationId: string;
  userId: string;
  scopes: Set<ApiScope>;
  /** Null means every project in the organization. */
  projectIds: string[] | null;
  canAccessProject: (projectId: string) => boolean;
  has: (scope: ApiScope) => boolean;
};

const USAGE_INTERVAL = 60_000;

function clientIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || null;
}

const json = (status: number, error: string) => Response.json({ error }, { status });

/**
 * Authenticate a bearer API token and check it carries `scope`.
 * Returns either the auth context or a ready error response.
 */
export async function requireToken(request: Request, scope: ApiScope): Promise<{ auth: ApiAuth; error?: never } | { auth?: never; error: Response }> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token.startsWith("srv_")) return { error: json(401, "Invalid or missing API token") };
  const [row] = await db.select().from(schema.apiToken).where(eq(schema.apiToken.tokenHash, sha256(token)));
  if (!row) return { error: json(401, "Invalid or missing API token") };
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return { error: json(401, "Token expired") };

  const scopes = expandScopes(row.scopes);
  if (!scopes.has(scope)) return { error: json(403, `This token is missing the "${scope}" scope (${SCOPE_INFO[scope].label}).`) };

  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > USAGE_INTERVAL) {
    void db
      .update(schema.apiToken)
      .set({ lastUsedAt: new Date(), lastUsedIp: clientIp(request) })
      .where(eq(schema.apiToken.id, row.id))
      .catch(() => {});
  }

  const projectIds = row.projectIds && row.projectIds.length ? row.projectIds : null;
  return {
    auth: {
      tokenId: row.id,
      organizationId: row.organizationId,
      userId: row.userId,
      scopes,
      projectIds,
      canAccessProject: (projectId) => !projectIds || projectIds.includes(projectId),
      has: (s) => scopes.has(s),
    },
  };
}

export const notFound = (what = "Not found") => json(404, what);

/** A service the token may access (same organization and an allowed project), or null. */
export async function tokenService(auth: ApiAuth, serviceId: string) {
  try {
    const row = await serviceInOrg(serviceId, auth.organizationId);
    return auth.canAccessProject(row.project.id) ? row : null;
  } catch {
    return null;
  }
}
