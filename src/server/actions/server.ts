"use server";

import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requireInstanceAdmin } from "@/server/auth";
import { db, schema } from "@/server/db";
import { getSettings, updateSettings, type Settings } from "@/server/settings";
import { enqueue } from "@/server/queue";
import { detectPublicIp, resolveA } from "@/server/system";
import { newId } from "@/server/id";
import { certificateCovers } from "@/server/ssl/match";
import { eq } from "drizzle-orm";
import { logActivity } from "@/server/activity";

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Enter a valid domain like example.com");

const settingsSchema = z
  .object({
    instanceName: z.string().trim().min(1).max(40),
    serverIp: z.union([z.ipv4("Enter a valid IPv4 address"), z.literal("")]),
    wildcardDomain: z.union([hostname, z.literal("")]),
    sslipFallback: z.boolean(),
    dashboardDomain: z.union([hostname, z.literal("")]),
    dashboardHttps: z.boolean(),
    acmeEmail: z.union([z.email("Enter a valid email"), z.literal("")]),
    acmeStaging: z.boolean(),
    imageRetention: z.number().int().min(1).max(50),
    metricsRetentionHours: z.number().int().min(1).max(24 * 30),
    buildConcurrency: z.number().int().min(1).max(16),
    proxyMaxBodySize: z.string().regex(/^\d+[kmg]?$/i, "Use a size like 100m"),
    allowOrganizationCreation: z.boolean(),
    timezone: z.string().refine((tz) => Intl.supportedValuesOf("timeZone").includes(tz) || tz === "UTC", "Choose a valid timezone"),
    proxyCustomConfig: z.string().max(20_000),
    dashboardAllowlist: z.array(z.string().trim().regex(/^[0-9a-f:.]+(\/\d{1,3})?$/i, "Use an IP or CIDR range like 203.0.113.0/24")).max(100),
    cleanupEnabled: z.boolean(),
    cleanupIntervalHours: z.number().int().min(1).max(24 * 7),
    cleanupDiskThreshold: z.number().int().min(50).max(99),
    cleanupBuildCacheDays: z.number().int().min(0).max(90),
    cleanupUnusedImages: z.boolean(),
  })
  .partial();

export async function saveServerSettings(input: z.input<typeof settingsSchema>) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    const data = settingsSchema.parse(input);
    const patch: Partial<Settings> = {};
    for (const [k, v] of Object.entries(data)) {
      (patch as Record<string, unknown>)[k] = v === "" ? null : v;
    }
    const before = await getSettings();
    await updateSettings(patch);
    const after = await getSettings();

    const proxyRelevant: (keyof Settings)[] = ["dashboardDomain", "dashboardHttps", "proxyMaxBodySize", "proxyCustomConfig", "dashboardAllowlist"];
    if (proxyRelevant.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))) await enqueue("proxy.sync", {});

    // Dashboard HTTPS: request a certificate from the Root organization.
    if (after.dashboardDomain && after.dashboardHttps && after.acmeEmail && after.rootOrganizationId) {
      const certs = await db.select().from(schema.certificate).where(eq(schema.certificate.organizationId, after.rootOrganizationId));
      if (!certs.some((c) => certificateCovers(c.domains, after.dashboardDomain!))) {
        const id = newId();
        await db.insert(schema.certificate).values({
          id,
          organizationId: after.rootOrganizationId,
          name: `Dashboard (${after.dashboardDomain})`,
          domains: [after.dashboardDomain],
          provider: "letsencrypt-http",
        });
        await enqueue("certificate.issue", { certificateId: id }, { concurrencyKey: `cert:${id}`, maxAttempts: 2 });
      }
    }
    // The setup guide saves each step; only log changes made afterwards.
    if (before.onboardingDone) {
      await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.settings", message: "Updated server settings" });
    }
    return null;
  });
}

export async function detectIp() {
  return act(async () => {
    await requireInstanceAdmin();
    const ip = await detectPublicIp();
    if (!ip) throw new UserError("Could not detect the public IP. Enter it manually.");
    return ip;
  });
}

export async function checkDns(host: string) {
  return act(async () => {
    await requireInstanceAdmin();
    const settings = await getSettings();
    const records = await resolveA(host);
    return { records, pointsHere: !!settings.serverIp && records.includes(settings.serverIp) };
  });
}

export async function finishOnboarding() {
  return act(async () => {
    await requireInstanceAdmin();
    await updateSettings({ onboardingDone: true });
    return null;
  });
}

export async function resyncProxy() {
  return act(async () => {
    await requireInstanceAdmin();
    await enqueue("proxy.sync", {});
    return null;
  });
}

export async function runCleanup() {
  return act(async () => {
    await requireInstanceAdmin();
    await enqueue("cleanup", { full: true });
    return null;
  });
}
