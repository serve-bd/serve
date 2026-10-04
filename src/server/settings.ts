import { defaultSignIn, type SignInSettings } from "@/server/sso/config";
import { and, eq, inArray, notLike, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import type { EmailSettings } from "@/server/email/config";
import type { BrandingConfig } from "@/lib/branding";
import type { OrgLimits } from "@/lib/limits";

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
  /** A certificate chosen for the dashboard domain (an uploaded one); null picks any that covers it, or requests one. */
  dashboardCertificateId: string | null;
  /** Email used for Let's Encrypt registration. */
  acmeEmail: string | null;
  acmeStaging: boolean;
  onboardingDone: boolean;
  /** The organization created during setup. Its admins manage the server. */
  rootOrganizationId: string | null;
  /** Let every user create organizations (otherwise only Root admins can). */
  allowOrganizationCreation: boolean;
  /** Organizations other than Root prove they own a domain (DNS TXT record) before adding it. */
  domainVerification: boolean;
  /** Limits for organizations that have none of their own (the Root organization is unlimited). */
  defaultOrgLimits: OrgLimits;
  /** Last time the worker reported in (ISO timestamp). */
  workerHeartbeat: string | null;
  /** The API token in <dataDir>/cli.json (the CLI on the Serve host); only this token is ever rotated. */
  serverCliTokenId: string | null;
  /** Cloudflare Tunnel (on the local server) that serves the dashboard domain; HTTPS by Cloudflare. */
  dashboardTunnelId: string | null;
  /** The dashboard domain is meant to use a tunnel; kept when the tunnel goes away so it can be reconnected. */
  dashboardWantsTunnel: boolean;
  /** Stable id of this Serve instance, stamped on containers it manages that another instance could see. */
  instanceId: string | null;
  /** Latest migration the running worker was built with. */
  workerSchemaVersion: string | null;
  /** Release the running worker was built from. */
  workerVersion: string | null;
  /** IANA timezone used for backup and task schedules. */
  timezone: string;
  /** Extra nginx directives included in the proxy's http block. */
  proxyCustomConfig: string | null;
  /** IPs or CIDR ranges allowed to open the dashboard through its domain. Empty allows everyone. */
  dashboardAllowlist: string[];
  /** The REST API (/api/v1) answers. Off: every call gets 503. */
  apiEnabled: boolean;
  /** Requests per minute per API token; 0 for no limit. */
  apiRateLimit: number;
  /** Automatic Docker cleanup. */
  cleanupEnabled: boolean;
  cleanupIntervalHours: number;
  /** Disk usage (percent) that triggers an aggressive cleanup. */
  cleanupDiskThreshold: number;
  cleanupBuildCacheDays: number;
  /** Also remove images no container uses, not only dangling ones. */
  cleanupUnusedImages: boolean;
  /** Also remove anonymous volumes no container uses (named volumes, which hold kept data, never). */
  cleanupUnusedVolumes: boolean;
  /** Also remove networks no container uses, except Serve's own and the ones services join. */
  cleanupUnusedNetworks: boolean;
  lastCleanup: CleanupRun | null;
  /** Most recent cleanup runs, newest first (max 10). */
  cleanupHistory: CleanupRun[];
  /** Outgoing email (password resets, invites, notifications). Null when not set up. */
  email: EmailSettings | null;
  /** Dashboard sign-in: password and single sign-on providers. */
  signIn: SignInSettings;
  /** Cron expression for backups of Serve itself; null turns them off. */
  instanceBackupSchedule: string | null;
  /** Instance backups kept (locally and in S3). */
  instanceBackupRetention: number;
  /** S3 destination (of the Root organization) that also receives instance backups. */
  instanceBackupS3DestinationId: string | null;
  /** Instance backups, newest first. */
  instanceBackups: InstanceBackup[];
  /** Look for new releases of Serve. */
  updateCheckEnabled: boolean;
  /** When to look, as a cron expression in the instance timezone. */
  updateCheckSchedule: string;
  updateCheck: UpdateCheck | null;
  /** Install new releases on their own, when `autoUpdateSchedule` fires. */
  autoUpdateEnabled: boolean;
  autoUpdateSchedule: string;
  /** The last firing of the auto-update schedule that was handled (ISO time). */
  autoUpdateLastDue: string | null;
  /** The last self-update, while it runs and after. */
  updateRun: UpdateRun | null;
  /** Logos, favicon and accent colour (the product name is instanceName). Null means the defaults. */
  branding: BrandingConfig | null;
  /** Where servers and private networks sit on the private networks canvas, by id. */
  networkCanvas: Record<string, { x: number; y: number }>;
  /** Host key of the tunnel listener (encrypted OpenSSH private key), made on first use. */
  tunnelHostKey: string | null;
  /** What the worker last reported about the tunnel listener. */
  tunnelListener: { port: number; listening: boolean; error: string | null; at: string } | null;
  /** Cloudflare's published proxy ranges, refreshed daily by the worker (null: the list bundled with Serve). */
  cloudflareRanges: { ranges: string[]; checkedAt: string } | null;
};

export type InstanceBackup = {
  id: string;
  createdAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "failed";
  trigger: "manual" | "schedule" | "update";
  filename: string | null;
  size: number | null;
  s3Key: string | null;
  s3Status: "uploaded" | "failed" | null;
  /** S3 destination the copy went to (missing on backups from before it was kept). */
  s3DestinationId?: string | null;
  error: string | null;
  version: string;
};

export type UpdateCheck = {
  checkedAt: string;
  latest: string | null;
  url: string | null;
  notes: string | null;
  publishedAt: string | null;
  error: string | null;
};

export type UpdateRun = {
  id: string;
  /** "rolled-back": the new version did not come up healthy and the previous one runs again. */
  state: "backing-up" | "running" | "success" | "failed" | "rolled-back";
  from: string;
  to: string;
  startedAt: string;
  finishedAt: string | null;
  /** Container that pulls the new image and restarts the stack. */
  container: string | null;
  log: string;
  /** Image references before and after, so a rollback and the clean-up know what to keep. */
  previousImage?: string | null;
  image?: string | null;
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
  dashboardCertificateId: null,
  acmeEmail: null,
  acmeStaging: false,
  onboardingDone: false,
  rootOrganizationId: null,
  allowOrganizationCreation: false,
  domainVerification: true,
  defaultOrgLimits: {},
  workerHeartbeat: null,
  serverCliTokenId: null,
  workerSchemaVersion: null,
  workerVersion: null,
  dashboardTunnelId: null,
  dashboardWantsTunnel: false,
  instanceId: null,
  timezone: "UTC",
  proxyCustomConfig: null,
  dashboardAllowlist: [],
  apiEnabled: true,
  apiRateLimit: 200,
  cleanupEnabled: true,
  cleanupIntervalHours: 24,
  cleanupDiskThreshold: 80,
  cleanupBuildCacheDays: 7,
  cleanupUnusedImages: false,
  cleanupUnusedVolumes: false,
  cleanupUnusedNetworks: false,
  lastCleanup: null,
  cleanupHistory: [],
  email: null,
  signIn: defaultSignIn,
  instanceBackupSchedule: null,
  instanceBackupRetention: 7,
  instanceBackupS3DestinationId: null,
  instanceBackups: [],
  updateCheckEnabled: true,
  updateCheckSchedule: "0 */6 * * *",
  updateCheck: null,
  autoUpdateEnabled: false,
  autoUpdateSchedule: "0 3 * * *",
  autoUpdateLastDue: null,
  updateRun: null,
  branding: null,
  networkCanvas: {},
  tunnelHostKey: null,
  tunnelListener: null,
  cloudflareRanges: null,
};

/** Rows holding uploaded branding images; kept out of getSettings() so pages do not load image bytes. */
export const BRAND_ASSET_PREFIX = "brandAsset:";

/** The local server row is the source of truth for the deprecated addressing keys. */
async function localAddressing(): Promise<Partial<Settings>> {
  const [row] = await db
    .select({ publicIp: schema.server.publicIp, wildcardDomain: schema.server.wildcardDomain, sslipFallback: schema.server.sslipFallback })
    .from(schema.server)
    .where(eq(schema.server.id, "local"));
  return row ? { serverIp: row.publicIp, wildcardDomain: row.wildcardDomain, sslipFallback: row.sslipFallback } : {};
}

export async function getSettings(): Promise<Settings> {
  const [rows, addressing] = await Promise.all([
    db
      .select()
      .from(schema.setting)
      // Commit status refusals (per git connection) are not settings either.
      .where(and(notLike(schema.setting.key, `${BRAND_ASSET_PREFIX}%`), notLike(schema.setting.key, "commitStatusBlock:%"), notLike(schema.setting.key, "defaultServer:%"))),
    localAddressing(),
  ]);
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
