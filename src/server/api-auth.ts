import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { sha256 } from "@/server/crypto";

/** Resolve a bearer API token to its organization. */
export async function apiAuth(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token.startsWith("srv_")) return null;
  const [row] = await db.select().from(schema.apiToken).where(eq(schema.apiToken.tokenHash, sha256(token)));
  if (!row) return null;
  void db.update(schema.apiToken).set({ lastUsedAt: new Date() }).where(eq(schema.apiToken.id, row.id)).catch(() => {});
  return { organizationId: row.organizationId, userId: row.userId };
}

export const unauthorized = () => Response.json({ error: "Invalid or missing API token" }, { status: 401 });
