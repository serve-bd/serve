import { eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";

export type Settings = {
  instanceName: string;
  /** Public IPv4 of this server. Used for DNS records and sslip.io domains. */
  serverIp: string | null;
  /** Wildcard base domain for generated app URLs, e.g. apps.example.com */
  wildcardDomain: string | null;
  /** Use <slug>.<ip>.sslip.io when no wildcard domain is configured. */
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
};

export async function getSettings(): Promise<Settings> {
  const rows = await db.select().from(schema.setting);
  const values = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { ...defaultSettings, ...values } as Settings;
}

export async function getSetting<K extends keyof Settings>(key: K): Promise<Settings[K]> {
  const [row] = await db.select().from(schema.setting).where(eq(schema.setting.key, key));
  return (row ? row.value : defaultSettings[key]) as Settings[K];
}

export async function updateSettings(patch: Partial<Settings>) {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
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
