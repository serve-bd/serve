import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LOCAL_SERVER_ID } from "@/server/db/schema";
import { getSettings } from "@/server/settings";

export type Addressing = { publicIp: string | null; wildcardDomain: string | null; sslipFallback: boolean };

/** How services on a server are reached from the internet: its IP, wildcard domain and sslip.io fallback. */
export async function serverAddressing(serverId: string | null | undefined = LOCAL_SERVER_ID): Promise<Addressing> {
  const [row] = await db
    .select({ publicIp: schema.server.publicIp, wildcardDomain: schema.server.wildcardDomain, sslipFallback: schema.server.sslipFallback })
    .from(schema.server)
    .where(eq(schema.server.id, serverId || LOCAL_SERVER_ID));
  if (row) return row;
  return { publicIp: null, wildcardDomain: null, sslipFallback: true };
}

/** Addressing of the server a service runs on. */
export async function serviceAddressing(serviceId: string): Promise<Addressing & { serverId: string }> {
  const [svc] = await db.select({ serverId: schema.service.serverId }).from(schema.service).where(eq(schema.service.id, serviceId));
  const serverId = svc?.serverId ?? LOCAL_SERVER_ID;
  return { serverId, ...(await serverAddressing(serverId)) };
}

/**
 * Automatic domain for a new service on a server: `<slug>.<wildcard>` (HTTPS when
 * Let's Encrypt is set up) or `<slug>.<ip>.sslip.io`.
 */
export async function autoDomainFor(slug: string, serverId: string | null | undefined = LOCAL_SERVER_ID): Promise<{ hostname: string; https: boolean } | null> {
  const [addr, settings] = await Promise.all([serverAddressing(serverId), getSettings()]);
  if (addr.wildcardDomain) return { hostname: `${slug}.${addr.wildcardDomain}`, https: !!settings.acmeEmail };
  if (addr.sslipFallback && addr.publicIp) return { hostname: `${slug}.${addr.publicIp}.sslip.io`, https: false };
  return null;
}

/** Updates the addressing of the machine Serve runs on (onboarding and instance settings). */
export async function updateLocalAddressing(patch: Partial<Addressing>) {
  const set: Partial<typeof schema.server.$inferInsert> = {};
  if (patch.publicIp !== undefined) set.publicIp = patch.publicIp || null;
  if (patch.wildcardDomain !== undefined) set.wildcardDomain = patch.wildcardDomain || null;
  if (patch.sslipFallback !== undefined) set.sslipFallback = patch.sslipFallback;
  if (Object.keys(set).length) await db.update(schema.server).set(set).where(eq(schema.server.id, LOCAL_SERVER_ID));
}
