import { eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";

export type Settings = {
  instanceName: string;
  /**
   * @deprecated Addressing lives on the server row now (server.public_ip, wildcard_domain,
   * sslip_fallback). getSettings() fills these three from the local server for old readers.
   * Public IPv4 of this server. Used for DNS records and sslip.io domains.
   */
  serverIp: string | null;
  /** @deprecated See serverIp. Wildcard base domain for generated app URLs, e.g. apps.example.com */
  wildcardDomain: string | null;
  /** @deprecated See serverIp. Use <slug>.<ip>.sslip.io when no wildcard domain is configured. */
  sslipFallback: boolean;
  /** Domain the dashboard itself is served on through the proxy. */
  dashboardDomain: string | null;
  dashboardHttps: boolean;
  /** Email used for Let's Encrypt registration. */
  acmeEmail: string | null;
  acmeStaging: boolean;
  /** Number of old images kept per service for rollbacks. */
  imageRetention: number;
  /** Days deployments logs are kept. */
  metricsRetentionHours: number;
  /** Maximum concurrent builds. */
  buildConcurrency: number;
  /** Max request body size for proxied apps, e.g. "100m". */
  proxyMaxBodySize: string;
  onboardingDone: boolean;
  /** The organization created during setup. Its admins manage the server. */
  rootOrganizationId: string | null;
  /** Let every user create organizations (otherwise only Root admins can). */
  allowOrganizationCreation: boolean;
  /** Last time the worker reported in (ISO timestamp). */
  workerHeartbeat: string | null;
  /** Cloudflare Tunnel (on the local server) that serves the dashboard domain; HTTPS by Cloudflare. */
  dashboardTunnelId: string | null;
  /** The dashboard domain is meant to use a tunnel; kept when the tunnel goes away so it can be reconnected. */
  dashboardWantsTunnel: boolean;
  /** Stable id of this Serve instance, stamped on containers it manages that another instance could see. */
  instanceId: string | null;
  /** Latest migration the running worker was built with. */
  workerSchemaVersion: string | null;
  /** IANA timezone used for backup and task schedules. */
  timezone: string;
  /** Extra nginx directives included in the proxy's http block. */
  proxyCustomConfig: string | null;
  /** IPs or CIDR ranges allowed to open the dashboard through its domain. Empty allows everyone. */
  dashboardAllowlist: string[];
  /** Automatic Docker cleanup. */
  cleanupEnabled: boolean;
  cleanupIntervalHours: number;
  /** Disk usage (percent) that triggers an aggressive cleanup. */
  cleanupDiskThreshold: number;
  cleanupBuildCacheDays: number;
  /** Also remove images no container uses, not only dangling ones. */
  cleanupUnusedImages: boolean;
  lastCleanup: CleanupRun | null;
  /** Most recent cleanup runs, newest first (max 10). */
  cleanupHistory: CleanupRun[];
};

export type CleanupRun = {
  at: string;
  trigger: "schedule" | "manual" | "disk";
  reclaimed: number;
  durationMs: number;
  error?: string | null;
  /** Server the run cleaned (missing on runs from before multi-server: the local server). */
  serverId?: string;
  serverName?: string;
};

export const defaultSettings: Settings = {
  instanceName: "Serve",
  serverIp: null,
  wildcardDomain: null,
  sslipFallback: true,
  dashboardDomain: null,
  dashboardHttps: true,
  acmeEmail: null,
  acmeStaging: false,
  imageRetention: 5,
  metricsRetentionHours: 48,
  buildConcurrency: 2,
  proxyMaxBodySize: "100m",
  onboardingDone: false,
  rootOrganizationId: null,
  allowOrganizationCreation: false,
  workerHeartbeat: null,
  workerSchemaVersion: null,
  dashboardTunnelId: null,
  dashboardWantsTunnel: false,
  instanceId: null,
  timezone: "UTC",
  proxyCustomConfig: null,
  dashboardAllowlist: [],
  cleanupEnabled: true,
  cleanupIntervalHours: 24,
  cleanupDiskThreshold: 80,
  cleanupBuildCacheDays: 7,
  cleanupUnusedImages: false,
  lastCleanup: null,
  cleanupHistory: [],
};

/** The local server row is the source of truth for the deprecated addressing keys. */
async function localAddressing(): Promise<Partial<Settings>> {
  const [row] = await db
    .select({ publicIp: schema.server.publicIp, wildcardDomain: schema.server.wildcardDomain, sslipFallback: schema.server.sslipFallback })
    .from(schema.server)
    .where(eq(schema.server.id, "local"));
  return row ? { serverIp: row.publicIp, wildcardDomain: row.wildcardDomain, sslipFallback: row.sslipFallback } : {};
}

export async function getSettings(): Promise<Settings> {
  const [rows, addressing] = await Promise.all([db.select().from(schema.setting), localAddressing()]);
  const values = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { ...defaultSettings, ...values, ...addressing } as Settings;
}

export async function getSetting<K extends keyof Settings>(key: K): Promise<Settings[K]> {
  if (key === "serverIp" || key === "wildcardDomain" || key === "sslipFallback") {
    const addressing = await localAddressing();
    if (key in addressing) return addressing[key] as Settings[K];
  }
  const [row] = await db.select().from(schema.setting).where(eq(schema.setting.key, key));
  return (row ? row.value : defaultSettings[key]) as Settings[K];
}

export async function updateSettings(patch: Partial<Settings>) {
  // null means "back to default": remove the row.
  const cleared = Object.entries(patch)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  if (cleared.length) await db.delete(schema.setting).where(inArray(schema.setting.key, cleared));
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined && v !== null);
  if (!entries.length) return;
  await db
    .insert(schema.setting)
    .values(entries.map(([key, value]) => ({ key, value: value as never })))
    .onConflictDoUpdate({
      target: schema.setting.key,
      set: { value: sqlExcluded("value"), updatedAt: new Date() },
    });
}

export async function deleteSettings(keys: (keyof Settings)[]) {
  await db.delete(schema.setting).where(inArray(schema.setting.key, keys));
}

function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}
