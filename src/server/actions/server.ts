"use server";

import { requireServerAdmin } from "@/server/servers/access";

import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requireInstanceAdmin } from "@/server/auth";
import { db, schema } from "@/server/db";
import { getSettings, updateSettings, type Settings } from "@/server/settings";
import { enqueue } from "@/server/queue";
import { detectPublicIp, resolveA } from "@/server/system";
import { newId } from "@/server/id";
import { certificateCovers } from "@/server/ssl/match";
import { and, eq } from "drizzle-orm";
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
    dashboardCertificateId: z.string().nullable(),
    acmeEmail: z.union([z.email("Enter a valid email"), z.literal("")]),
    acmeStaging: z.boolean(),
    allowOrganizationCreation: z.boolean(),
    domainVerification: z.boolean(),
    dashboardTunnelId: z.string().nullable(),
    /** The dashboard should use a tunnel, even while none is available (it reconnects later). */
    dashboardWantsTunnel: z.boolean(),
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
    apiEnabled: z.boolean(),
    apiRateLimit: z.number().int().min(0).max(100_000),
    cleanupEnabled: z.boolean(),
    cleanupIntervalHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 7),
    cleanupDiskThreshold: z.number().int().min(50).max(99),
    cleanupBuildCacheDays: z.number().int().min(0).max(90),
    cleanupUnusedImages: z.boolean(),
    cleanupUnusedVolumes: z.boolean(),
    cleanupUnusedNetworks: z.boolean(),
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
    // The route choice: a chosen tunnel implies the wish; without a domain there is nothing to keep.
    if (data.dashboardWantsTunnel === undefined && data.dashboardTunnelId !== undefined) patch.dashboardWantsTunnel = !!tunnelId;
    if (!domain) patch.dashboardWantsTunnel = false;
    // A chosen certificate: the Root organization's, on the server the dashboard runs on, for its domain.
    const certificateId = data.dashboardCertificateId === undefined ? before.dashboardCertificateId : data.dashboardCertificateId;
    if (certificateId && domain && (data.dashboardCertificateId !== undefined || data.dashboardDomain !== undefined)) {
      const [cert] = await db.select().from(schema.certificate).where(eq(schema.certificate.id, certificateId));
      if (!cert || cert.organizationId !== before.rootOrganizationId || cert.serverId !== LOCAL_SERVER_ID)
        throw new UserError("Choose a certificate of the Root organization on this server.");
      if (!certificateCovers(cert.domains, domain)) throw new UserError(`${cert.name} does not cover ${domain}.`);
    }
    if (!domain) patch.dashboardCertificateId = null;
    if (tunnelId && domain && (data.dashboardTunnelId !== undefined || data.dashboardDomain !== undefined)) {
      const [tunnel] = await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.id, tunnelId));
      if (tunnel?.serverId !== "local") throw new UserError("Choose a tunnel on the server the dashboard runs on.");
      // Cloudflare decrypts what a tunnel carries: the dashboard only goes through the Root organization's own account.
      if (tunnel.organizationId !== before.rootOrganizationId) throw new UserError("Choose a tunnel of the Root organization.");
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
      patch.dashboardCertificateId = null;
    }
    // Addressing belongs to the local server row; the settings keys are deprecated.
    const { serverIp, wildcardDomain, sslipFallback, ...rest } = patch;
    await updateLocalAddressing({ publicIp: serverIp, wildcardDomain, sslipFallback });
    await updateSettings(rest);
    const after = await getSettings();
    // Off the tunnel (or to another domain): the record Serve pointed at the tunnel goes, or the
    // old name keeps reaching a tunnel that no longer routes it (Cloudflare answers 404).
    const offTunnel = !!before.dashboardTunnelId && !!before.dashboardDomain && !(after.dashboardTunnelId && after.dashboardDomain === before.dashboardDomain);
    if (offTunnel) {
      const { cloudflareAccountFor } = await import("@/server/ssl/certificates");
      const { Cloudflare } = await import("@/server/cloudflare/api");
      const accountId = await cloudflareAccountFor([before.dashboardDomain!], before.rootOrganizationId ?? "").catch(() => null);
      if (accountId)
        await (async () => {
          const cf = await Cloudflare.forAccount(accountId);
          const zone = await cf.zoneFor(before.dashboardDomain!);
          if (!zone) return;
          for (const r of await cf.dnsRecords(zone.id, { name: before.dashboardDomain! }))
            if (r.type === "CNAME" && r.content.endsWith(".cfargotunnel.com") && r.comment === "Managed by Serve") await cf.deleteDnsRecord(zone.id, r.id);
        })().catch(() => {});
    }
    if (before.dashboardTunnelId !== after.dashboardTunnelId || before.dashboardDomain !== after.dashboardDomain) {
      const { syncTunnelIngress } = await import("@/server/cloudflare/tunnels");
      for (const id of new Set([before.dashboardTunnelId, after.dashboardTunnelId].filter(Boolean) as string[])) await syncTunnelIngress(id).catch(() => {});
    }

    // GitHub Apps send pushes to the address they were created with: move them to the new one.
    if (["dashboardDomain", "dashboardHttps", "dashboardTunnelId"].some((k) => JSON.stringify(before[k as keyof Settings]) !== JSON.stringify(after[k as keyof Settings]))) {
      const { syncAppWebhooks } = await import("@/server/git/github-app");
      void syncAppWebhooks().catch(() => {});
    }

    const proxyRelevant: (keyof Settings)[] = ["dashboardDomain", "dashboardHttps", "dashboardCertificateId", "dashboardTunnelId", "proxyCustomConfig", "dashboardAllowlist"];
    if (proxyRelevant.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))) await enqueue("proxy.sync", {});

    // Dashboard HTTPS: request a certificate from the Root organization, unless one was chosen.
    if (after.dashboardDomain && after.dashboardHttps && !after.dashboardCertificateId && !after.dashboardTunnelId && after.acmeEmail && after.rootOrganizationId) {
      // Only the local proxy serves the dashboard, and only an active certificate (or one on its way) counts.
      const covering = (
        await db
          .select()
          .from(schema.certificate)
          .where(and(eq(schema.certificate.organizationId, after.rootOrganizationId), eq(schema.certificate.serverId, LOCAL_SERVER_ID)))
      ).filter((c) => certificateCovers(c.domains, after.dashboardDomain!));
      const retry = covering.find((c) => c.provider !== "custom");
      const served = covering.some((c) => c.status === "active" || c.status === "pending" || c.status === "issuing");
      // A failed or expired one is requested again rather than doubled.
      if (!served && retry) {
        await enqueue("certificate.issue", { certificateId: retry.id }, { concurrencyKey: `cert:${retry.id}`, maxAttempts: 2 });
      } else if (!served) {
        const id = newId();
        await db.insert(schema.certificate).values({
          id,
          organizationId: after.rootOrganizationId,
          serverId: LOCAL_SERVER_ID,
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
    const ctx = await requireInstanceAdmin();
    // Onboarding no longer asks for it: certificates go to the owner's address until it is changed in Settings.
    const settings = await getSettings();
    await updateSettings({ onboardingDone: true, ...(settings.acmeEmail ? {} : { acmeEmail: ctx.user.email }) });
    return null;
  });
}

/** Queues a full cleanup on one server (the local server by default). */
export async function runCleanup(serverId: string = LOCAL_SERVER_ID) {
  return act(async () => {
    await requireServerAdmin(serverId);
    const [server] = await db.select({ id: schema.server.id }).from(schema.server).where(eq(schema.server.id, serverId));
    if (!server) throw new UserError("Server not found.");
    await enqueue("cleanup", { full: true, serverId }, { concurrencyKey: `cleanup:${serverId}` });
    return null;
  });
}
