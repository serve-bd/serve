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
import { LOCAL_SERVER_ID } from "@/server/db/schema";
import { updateLocalAddressing } from "@/server/proxy/addressing";

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
    metricsRetentionHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30),
    buildConcurrency: z.number().int().min(1).max(16),
    proxyMaxBodySize: z.string().regex(/^\d+[kmg]?$/i, "Use a size like 100m"),
    allowOrganizationCreation: z.boolean(),
    dashboardTunnelId: z.string().nullable(),
    timezone: z.string().refine((tz) => Intl.supportedValuesOf("timeZone").includes(tz) || tz === "UTC", "Choose a valid timezone"),
    proxyCustomConfig: z.string().max(20_000),
    dashboardAllowlist: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[0-9a-f:.]+(\/\d{1,3})?$/i, "Use an IP or CIDR range like 203.0.113.0/24"),
      )
      .max(100),
    cleanupEnabled: z.boolean(),
    cleanupIntervalHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 7),
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
    // Routing the dashboard through a tunnel: Cloudflare serves HTTPS, so no certificate here.
    let tunnelId = data.dashboardTunnelId === undefined ? before.dashboardTunnelId : data.dashboardTunnelId;
    const domain = data.dashboardDomain === undefined ? before.dashboardDomain : data.dashboardDomain || null;
    // No domain means nothing to route: drop the tunnel choice instead of refusing to save.
    if (tunnelId && !domain) {
      tunnelId = null;
      patch.dashboardTunnelId = null;
    }
    if (tunnelId && domain && (data.dashboardTunnelId !== undefined || data.dashboardDomain !== undefined)) {
      const [tunnel] = await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.id, tunnelId));
      if (tunnel?.serverId !== "local") throw new UserError("Choose a tunnel on the server Serve runs on.");
      const { Cloudflare } = await import("@/server/cloudflare/api");
      const cf = await Cloudflare.forAccount(tunnel.cloudflareAccountId);
      const zone = await cf.zoneFor(domain).catch(() => null);
      if (!zone) throw new UserError(`${domain} is not in a zone of the tunnel's Cloudflare account.`);
      try {
        await cf.upsertTunnelRecord(zone.id, domain, tunnel.cfTunnelId);
      } catch (e) {
        throw new UserError(`Could not point ${domain} at the tunnel: ${(e as Error).message}`);
      }
      patch.dashboardHttps = false;
    }
    // Addressing belongs to the local server row; the settings keys are deprecated.
    const { serverIp, wildcardDomain, sslipFallback, ...rest } = patch;
    await updateLocalAddressing({ publicIp: serverIp, wildcardDomain, sslipFallback });
    await updateSettings(rest);
    const after = await getSettings();
    if (before.dashboardTunnelId !== after.dashboardTunnelId || before.dashboardDomain !== after.dashboardDomain) {
      const { syncTunnelIngress } = await import("@/server/cloudflare/tunnels");
      for (const id of new Set([before.dashboardTunnelId, after.dashboardTunnelId].filter(Boolean) as string[])) await syncTunnelIngress(id).catch(() => {});
    }

    const proxyRelevant: (keyof Settings)[] = ["dashboardDomain", "dashboardHttps", "dashboardTunnelId", "proxyMaxBodySize", "proxyCustomConfig", "dashboardAllowlist"];
    if (proxyRelevant.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))) await enqueue("proxy.sync", {});

    // Dashboard HTTPS: request a certificate from the Root organization.
    if (after.dashboardDomain && after.dashboardHttps && !after.dashboardTunnelId && after.acmeEmail && after.rootOrganizationId) {
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

/** Queues a full cleanup on one server (the local server by default). */
export async function runCleanup(serverId: string = LOCAL_SERVER_ID) {
  return act(async () => {
    await requireInstanceAdmin();
    const [server] = await db.select({ id: schema.server.id }).from(schema.server).where(eq(schema.server.id, serverId));
    if (!server) throw new UserError("Server not found.");
    await enqueue("cleanup", { full: true, serverId }, { concurrencyKey: `cleanup:${serverId}` });
    return null;
  });
}
