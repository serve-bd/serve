import { isNotNull } from "drizzle-orm";
import { db, schema } from "@/server/db";

let cached: { at: number; map: Map<string, string> } | null = null;
const TTL_MS = 10_000;

/**
 * The status page served on a hostname, if any. Asked on every request by the proxy file, so the
 * list is kept for a few seconds; a new domain works within that time.
 */
export async function statusSlugForHost(host: string): Promise<string | null> {
  if (!cached || Date.now() - cached.at > TTL_MS) {
    try {
      const rows = await db.select({ slug: schema.statusPage.slug, domain: schema.statusPage.domain }).from(schema.statusPage).where(isNotNull(schema.statusPage.domain));
      cached = { at: Date.now(), map: new Map(rows.map((r) => [r.domain!.toLowerCase(), r.slug])) };
    } catch {
      // No database (a build, or it is restarting): no status domains rather than a broken dashboard.
      return cached?.map.get(host) ?? null;
    }
  }
  return cached.map.get(host) ?? null;
}

/** The host a request was made to: lower case, without a port. */
export function requestHost(headers: Pick<Headers, "get">) {
  const raw = headers.get("host");
  if (!raw) return null;
  return raw.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}
