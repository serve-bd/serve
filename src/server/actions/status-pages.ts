"use server";

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { logActivity } from "@/server/activity";
import { requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { LOCAL_SERVER_ID } from "@/server/db/schema";
import { newId } from "@/server/id";
import { enqueue } from "@/server/queue";
import { Cloudflare } from "@/server/cloudflare/api";
import { syncTunnelIngress } from "@/server/cloudflare/tunnels";
import { getSettings } from "@/server/settings";
import { domainDnsStatus } from "@/server/dns";
import { assertNotDashboardHost, domainOwnership, ownershipMessage } from "@/server/domains/ownership";
import { cloudflareAccountFor, retireCertificateFor } from "@/server/ssl/certificates";
import { certificateCovers } from "@/server/ssl/match";
import { checkBrandImage } from "@/lib/branding";
import { BAR_DAYS, cleanCss, cleanUrl, DEFAULT_LABELS, designOf, INCIDENT_STATES, type LabelKey, RESERVED_SLUGS, type StatusDesign, slugify, slugPattern } from "@/lib/status-page";

/**
 * Status pages span every project (a page lists services from any of them): only members who reach
 * every project manage them, like tags.
 */
async function requireStatusManager() {
  const ctx = await requirePermission("status-pages.manage");
  if (ctx.projectIds) throw new UserError("Status pages span every project: only members with access to all projects manage them.");
  return ctx;
}

async function pageInOrg(pageId: string, organizationId: string) {
  const [row] = await db
    .select({
      id: schema.statusPage.id,
      name: schema.statusPage.name,
      slug: schema.statusPage.slug,
      domain: schema.statusPage.domain,
      https: schema.statusPage.https,
      certificateId: schema.statusPage.certificateId,
      tunnelId: schema.statusPage.tunnelId,
      visibility: schema.statusPage.visibility,
      passwordHash: schema.statusPage.passwordHash,
      design: schema.statusPage.design,
      images: schema.statusPage.images,
    })
    .from(schema.statusPage)
    .where(and(eq(schema.statusPage.id, pageId), eq(schema.statusPage.organizationId, organizationId)));
  if (!row) throw new UserError("Status page not found.");
  return row;
}

async function touch(pageId: string) {
  await db.update(schema.statusPage).set({ updatedAt: new Date() }).where(eq(schema.statusPage.id, pageId));
}

async function freeSlug(slug: string, except?: string) {
  if (!slugPattern.test(slug)) throw new UserError("Use lower-case letters, digits and dashes for the address, like acme or acme-cloud.");
  if (RESERVED_SLUGS.includes(slug)) throw new UserError(`The address ${slug} is reserved. Pick another one.`);
  const [taken] = await db
    .select({ id: schema.statusPage.id })
    .from(schema.statusPage)
    .where(and(eq(schema.statusPage.slug, slug), except ? ne(schema.statusPage.id, except) : undefined));
  if (taken) throw new UserError(`The address /status/${slug} is taken. Pick another one.`);
}

export async function createStatusPage(input: { name: string; slug?: string }) {
  return act(async () => {
    const ctx = await requireStatusManager();
    const data = z.object({ name: z.string().trim().min(1, "Give the page a name.").max(80), slug: z.string().trim().toLowerCase().optional() }).parse(input);
    let slug = data.slug || slugify(data.name) || "status";
    if (!data.slug) {
      // A free address from the name: acme, acme-2, acme-3…
      const base = slug;
      for (let i = 2; ; i++) {
        const [taken] = await db.select({ id: schema.statusPage.id }).from(schema.statusPage).where(eq(schema.statusPage.slug, slug));
        if (!taken && !RESERVED_SLUGS.includes(slug)) break;
        slug = `${base.slice(0, 44)}-${i}`;
      }
    }
    await freeSlug(slug);
    const id = newId();
    await db.insert(schema.statusPage).values({ id, organizationId: ctx.org.id, name: data.name, slug });
    // Every check of the organization's services, to start from: the owner removes what should not be public.
    const monitored = await db
      .select({ serviceId: schema.monitor.serviceId, name: schema.service.name })
      .from(schema.monitor)
      .innerJoin(schema.service, eq(schema.monitor.serviceId, schema.service.id))
      .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
      .where(eq(schema.project.organizationId, ctx.org.id));
    if (monitored.length) {
      await db
        .insert(schema.statusComponent)
        .values(monitored.sort((a, b) => a.name.localeCompare(b.name)).map((m, i) => ({ id: newId(), pageId: id, serviceId: m.serviceId, name: m.name, position: i })));
    }
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "status-page.create",
      message: `Created the status page ${data.name}`,
      targetType: "status-page",
      targetId: id,
    });
    return { id };
  });
}

export async function deleteStatusPage(pageId: string) {
  return act(async () => {
    const ctx = await requireStatusManager();
    const page = await pageInOrg(pageId, ctx.org.id);
    await db.delete(schema.statusPage).where(eq(schema.statusPage.id, pageId));
    if (page.tunnelId && page.domain) {
      await dropTunnelRecord(page.tunnelId, page.domain);
      await syncTunnelIngress(page.tunnelId).catch(() => {});
    }
    const warning = page.domain && !page.tunnelId ? await dropStatusARecord(ctx.org.id, page.domain) : null;
    if (page.domain) {
      await retireCertificateFor(page.domain, LOCAL_SERVER_ID, ctx.org.id);
      await enqueue("proxy.sync", {});
    }
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "status-page.delete", message: `Deleted the status page ${page.name}` });
    return warning ? { warning } : null;
  });
}

/* -------------------------------------------------------------------------- */
/*                               Name and look                                */
/* -------------------------------------------------------------------------- */

const designInput = z.object({
  theme: z.enum(["auto", "light", "dark"]),
  accent: z.string().max(20).nullable(),
  description: z.string().max(500).nullable(),
  website: z.string().max(500).nullable(),
  showName: z.boolean(),
  days: z.union(BAR_DAYS.map((d) => z.literal(d)) as unknown as [z.ZodLiteral<30>, z.ZodLiteral<60>, z.ZodLiteral<90>]),
  showBars: z.boolean(),
  showUptime: z.boolean(),
  showLatency: z.boolean(),
  historyDays: z.number().int().min(0).max(90),
  autoIncidents: z.boolean(),
  announcement: z.object({ text: z.string().max(500), tone: z.enum(["info", "warn"]) }).nullable(),
  links: z.array(z.object({ label: z.string().trim().max(40), url: z.string().max(500) })).max(50),
  footer: z.string().max(500).nullable(),
  hideBadge: z.boolean(),
  font: z.enum(["sans", "serif", "mono"]),
  corners: z.enum(["round", "square"]),
  density: z.enum(["comfortable", "compact"]),
  css: z.string().max(20_000).nullable(),
  noindex: z.boolean(),
  labels: z.record(z.string(), z.string().max(200)),
  locale: z.string().trim().max(35).nullable(),
});

function validLocale(locale: string) {
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? null;
  } catch {
    throw new UserError(`${locale} is not a language code. Use one like en, de or pt-BR.`);
  }
}

/** Save the name, address and look. Logos are uploaded on their own. */
export async function saveStatusPage(pageId: string, input: { name: string; slug: string; design: Omit<StatusDesign, "logo" | "logoDark"> }) {
  return act(async () => {
    const ctx = await requireStatusManager();
    const page = await pageInOrg(pageId, ctx.org.id);
    const data = z.object({ name: z.string().trim().min(1, "Give the page a name.").max(80), slug: z.string().trim().toLowerCase(), design: designInput }).parse(input);
    if (data.slug !== page.slug) await freeSlug(data.slug, pageId);
    const d = data.design;
    let accent: string | null = null;
    if (d.accent?.trim()) {
      const { normalizeHex } = await import("@/lib/branding");
      accent = normalizeHex(d.accent);
      if (!accent) throw new UserError("Enter the accent color as a hex value, like #0a84ff.");
    }
    const website = d.website?.trim() ? cleanUrl(d.website) : null;
    if (d.website?.trim() && !website) throw new UserError("The website link must be an http or https address.");
    const links = d.links.filter((l) => l.label || l.url.trim());
    for (const l of links) {
      if (!l.label) throw new UserError("Every link needs a label.");
      if (!cleanUrl(l.url)) throw new UserError(`The link ${l.label} needs an http, https or mailto address.`);
    }
    const text = (v: string | null) => v?.trim() || null;
    const design: Partial<StatusDesign> = {
      ...designOf(page.design),
      ...d,
      accent,
      website,
      description: text(d.description),
      footer: text(d.footer),
      announcement: d.announcement?.text.trim() ? { text: d.announcement.text.trim(), tone: d.announcement.tone } : null,
      links: links.map((l) => ({ label: l.label, url: cleanUrl(l.url)! })),
      css: cleanCss(d.css),
      // Only known texts, and only those that differ from the default.
      labels: Object.fromEntries(
        Object.entries(d.labels)
          .filter(([k, v]) => k in DEFAULT_LABELS && v.trim() && v.trim() !== DEFAULT_LABELS[k as LabelKey])
          .map(([k, v]) => [k, v.trim()]),
      ),
      locale: d.locale ? validLocale(d.locale) : null,
    };
    await db.update(schema.statusPage).set({ name: data.name, slug: data.slug, design, updatedAt: new Date() }).where(eq(schema.statusPage.id, pageId));
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "status-page.update",
      message: `Updated the status page ${data.name}`,
      targetType: "status-page",
      targetId: pageId,
    });
    return null;
  });
}

export async function uploadStatusLogo(pageId: string, kind: "logo" | "logoDark" | "favicon", form: FormData) {
  return act(async () => {
    const ctx = await requireStatusManager();
    const page = await pageInOrg(pageId, ctx.org.id);
    if (kind !== "logo" && kind !== "logoDark" && kind !== "favicon") throw new UserError("Unknown image.");
    const file = form.get("file");
    if (!(file instanceof File)) throw new UserError("Choose a file.");
    const buf = new Uint8Array(await file.arrayBuffer());
    const checked = checkBrandImage(kind, buf);
    if (checked.error !== null) throw new UserError(checked.error);
    const hash = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
    const images = { ...page.images, [kind]: { hash, mime: checked.mime, data: Buffer.from(buf).toString("base64") } };
    await db.update(schema.statusPage).set({ images, updatedAt: new Date() }).where(eq(schema.statusPage.id, pageId));
    return { hash };
  });
}

export async function removeStatusLogo(pageId: string, kind: "logo" | "logoDark" | "favicon") {
  return act(async () => {
    const ctx = await requireStatusManager();
    const page = await pageInOrg(pageId, ctx.org.id);
    const images = { ...page.images };
    delete images[kind];
    await db.update(schema.statusPage).set({ images, updatedAt: new Date() }).where(eq(schema.statusPage.id, pageId));
    return null;
  });
}

/* -------------------------------------------------------------------------- */
/*                              Domain and access                             */
/* -------------------------------------------------------------------------- */

export async function setStatusVisibility(pageId: string, input: { visibility: "public" | "password" | "draft"; password?: string }) {
  return act(async () => {
    const ctx = await requireStatusManager();
    const page = await pageInOrg(pageId, ctx.org.id);
    const data = z.object({ visibility: z.enum(["public", "password", "draft"]), password: z.string().max(200).optional() }).parse(input);
    let passwordHash = page.passwordHash;
    if (data.password) {
      if (data.password.length < 6) throw new UserError("Use at least 6 characters for the password.");
      passwordHash = await bcrypt.hash(data.password, 10);
    }
    if (data.visibility === "password" && !passwordHash) throw new UserError("Set a password first.");
    await db.update(schema.statusPage).set({ visibility: data.visibility, passwordHash, updatedAt: new Date() }).where(eq(schema.statusPage.id, pageId));
    const said = { public: "Published", password: "Put behind a password", draft: "Unpublished" }[data.visibility];
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "status-page.visibility",
      message: `${said} the status page ${page.name}`,
      targetType: "status-page",
      targetId: pageId,
    });
    return null;
  });
}

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Enter a domain like status.example.com");

/**
 * Give the page its own domain (or take it away). The dashboard's proxy serves it; with HTTPS on an
 * nginx proxy Serve asks Let's Encrypt for a certificate (Caddy and Traefik get their own).
 */
export async function setStatusDomain(pageId: string, input: { domain: string; https: boolean; tunnelId?: string | null; certificateId?: string | null }) {
  return act(async () => {
    const ctx = await requireStatusManager();
    const page = await pageInOrg(pageId, ctx.org.id);
    const https = z.boolean().parse(input.https);
    const domain = input.domain.trim() ? hostname.parse(input.domain) : null;
    const tunnelId = domain ? (z.string().nullish().parse(input.tunnelId) ?? null) : null;
    if (domain) {
      await assertNotDashboardHost({ isRoot: false }, domain);
      const [service] = await db.select({ id: schema.domain.id }).from(schema.domain).where(eq(schema.domain.hostname, domain));
      if (service) throw new UserError(`${domain} is a domain of a service already. Use another name, like status.${domain.split(".").slice(-2).join(".")}.`);
      const [other] = await db
        .select({ id: schema.statusPage.id })
        .from(schema.statusPage)
        .where(and(eq(schema.statusPage.domain, domain), ne(schema.statusPage.id, pageId)));
      if (other) throw new UserError(`${domain} is the domain of another status page.`);
      const ownership = await domainOwnership({ id: ctx.org.id, isRoot: ctx.isRoot }, domain);
      if (!ownership.verified) throw new UserError(ownershipMessage(domain, ownership));
    }
    // Through a tunnel: one of the organization's on the server the dashboard runs on. Serve points
    // the name at it in Cloudflare; Cloudflare serves HTTPS, so no certificate here.
    // DNS records in Cloudflare are changed by organization admins only, as for app domains.
    if (tunnelId && (tunnelId !== page.tunnelId || domain !== page.domain) && !ctx.isAdmin) throw new UserError("Only organization admins can route a domain through a tunnel.");
    const tunnel = tunnelId ? await localTunnel(tunnelId, ctx.org.id) : null;
    // A chosen certificate: the organization's, on the server the dashboard runs on, covering the name.
    const certificateId = domain && https && !tunnel ? (z.string().nullish().parse(input.certificateId) ?? null) : null;
    if (certificateId) {
      const [cert] = await db
        .select({ name: schema.certificate.name, domains: schema.certificate.domains })
        .from(schema.certificate)
        .where(and(eq(schema.certificate.id, certificateId), eq(schema.certificate.organizationId, ctx.org.id), eq(schema.certificate.serverId, LOCAL_SERVER_ID)));
      if (!cert) throw new UserError("Choose a certificate of your organization on the dashboard's server.");
      if (!certificateCovers(cert.domains, domain!)) throw new UserError(`${cert.name} does not cover ${domain}.`);
    }
    if (tunnel && domain && (tunnel.id !== page.tunnelId || domain !== page.domain)) {
      const cf = await Cloudflare.forAccount(tunnel.cloudflareAccountId);
      const zone = await cf.zoneFor(domain).catch(() => null);
      if (!zone) throw new UserError(`${domain} is not in a zone of the tunnel's Cloudflare account.`);
      try {
        await cf.upsertTunnelRecord(zone.id, domain, tunnel.cfTunnelId);
      } catch (e) {
        throw new UserError(`Could not point ${domain} at the tunnel: ${(e as Error).message}`);
      }
    }
    const warnings: string[] = [];
    // Public IP route: the record a connected Cloudflare account can hold is made or set right on
    // every save (also when coming off a tunnel: Serve's CNAME to it is replaced). The old name's goes.
    if (domain && !tunnel && ctx.isAdmin) {
      const w = await pointStatusDomain(ctx.org.id, domain);
      if (w) warnings.push(w);
    }
    if (page.domain && !page.tunnelId && (page.domain !== domain || tunnel) && ctx.isAdmin) {
      const w = await dropStatusARecord(ctx.org.id, page.domain);
      if (w) warnings.push(w);
    }
    if (page.domain && page.domain !== domain) await retireCertificateFor(page.domain, LOCAL_SERVER_ID, ctx.org.id);
    // Off the tunnel, or to another name: the record Serve made for the old route goes.
    if (page.tunnelId && page.domain && (page.tunnelId !== tunnelId || page.domain !== domain)) await dropTunnelRecord(page.tunnelId, page.domain);
    await db
      .update(schema.statusPage)
      .set({ domain, https: tunnel ? false : https, tunnelId: tunnel?.id ?? null, certificateId, updatedAt: new Date() })
      .where(eq(schema.statusPage.id, pageId));
    for (const id of new Set([page.tunnelId, tunnel?.id].filter((t): t is string => !!t))) await syncTunnelIngress(id).catch(() => {});
    if (domain && https && !tunnel && !certificateId) await requestCertificate(ctx.org.id, domain);
    await enqueue("proxy.sync", {});
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "status-page.domain",
      message: domain
        ? `Set the domain of the status page ${page.name} to ${domain}${tunnel ? " through a Cloudflare Tunnel" : ""}`
        : `Removed the domain of the status page ${page.name}`,
      targetType: "status-page",
      targetId: pageId,
    });
    return warnings.length ? { warning: warnings.join(" ") } : null;
  });
}

async function localTunnel(tunnelId: string, organizationId: string) {
  const [tunnel] = await db
    .select()
    .from(schema.cloudflareTunnel)
    .where(and(eq(schema.cloudflareTunnel.id, tunnelId), eq(schema.cloudflareTunnel.organizationId, organizationId)));
  if (!tunnel) throw new UserError("Tunnel not found.");
  if (tunnel.serverId !== LOCAL_SERVER_ID) throw new UserError("Choose a tunnel on the server the dashboard runs on: it serves the status page.");
  return tunnel;
}

/** Remove the CNAME Serve made to point a name at a tunnel. Records someone else made stay. */
async function dropTunnelRecord(tunnelId: string, hostname: string) {
  const [tunnel] = await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.id, tunnelId));
  if (!tunnel) return;
  await (async () => {
    const cf = await Cloudflare.forAccount(tunnel.cloudflareAccountId);
    const zone = await cf.zoneFor(hostname);
    if (!zone) return;
    for (const r of await cf.dnsRecords(zone.id, { name: hostname }))
      if (r.type === "CNAME" && r.content === `${tunnel.cfTunnelId}.cfargotunnel.com` && r.comment === "Managed by Serve") await cf.deleteDnsRecord(zone.id, r.id);
  })().catch(() => {});
}

/**
 * On the public IP route, the A record of a name a connected Cloudflare account of the organization
 * manages: Serve makes it (DNS only, so this server's certificate answers), as for app domains.
 * Records someone else made are never changed. Returns why it could not, or null.
 */
async function pointStatusDomain(organizationId: string, hostname: string): Promise<string | null> {
  const accountId = await cloudflareAccountFor([hostname], organizationId).catch(() => null);
  if (!accountId) return null;
  // The address the DNS check expects, the one the page tells to use.
  const ip = (await getSettings()).serverIp;
  if (!ip) return `Serve did not create the A record for ${hostname}: set this server's public IP in Server settings.`;
  try {
    const cf = await Cloudflare.forAccount(accountId);
    const zone = await cf.zoneFor(hostname);
    if (zone) await cf.upsertARecord(zone.id, hostname, ip, false);
    return null;
  } catch (e) {
    return `Serve could not create the A record for ${hostname}: ${(e as Error).message}`;
  }
}

/** Remove the A record Serve made for a status page's name (marked by its comment). Returns why it could not, or null. */
async function dropStatusARecord(organizationId: string, hostname: string): Promise<string | null> {
  const accountId = await cloudflareAccountFor([hostname], organizationId).catch(() => null);
  if (!accountId) return null;
  try {
    const cf = await Cloudflare.forAccount(accountId);
    const zone = await cf.zoneFor(hostname);
    if (!zone) return null;
    for (const r of await cf.dnsRecords(zone.id, { name: hostname })) if (r.type === "A" && r.comment === "Managed by Serve") await cf.removeDnsRecord(zone.id, r.id);
    return null;
  } catch (e) {
    return `The A record Serve made for ${hostname} was not removed: ${(e as Error).message}. Remove it in Cloudflare.`;
  }
}

/** A Let's Encrypt certificate for the page's domain on the local proxy, unless one covers it or the proxy gets its own. */
async function requestCertificate(organizationId: string, domain: string) {
  const [local] = await db.select({ kind: schema.server.proxyKind }).from(schema.server).where(eq(schema.server.id, LOCAL_SERVER_ID));
  if (local && local.kind !== "nginx") return;
  const settings = await getSettings();
  if (!settings.acmeEmail) return;
  const covering = (
    await db
      .select()
      .from(schema.certificate)
      .where(and(eq(schema.certificate.organizationId, organizationId), eq(schema.certificate.serverId, LOCAL_SERVER_ID)))
  ).filter((c) => certificateCovers(c.domains, domain));
  const served = covering.some((c) => c.status === "active" || c.status === "pending" || c.status === "issuing");
  const retry = covering.find((c) => c.provider !== "custom");
  if (served) return;
  if (retry) {
    await enqueue("certificate.issue", { certificateId: retry.id }, { concurrencyKey: `cert:${retry.id}`, maxAttempts: 2 });
    return;
  }
  const cloudflareAccountId = await cloudflareAccountFor([domain], organizationId).catch(() => null);
  const id = newId();
  await db.insert(schema.certificate).values({
    id,
    organizationId,
    serverId: LOCAL_SERVER_ID,
    name: domain,
    domains: [domain],
    provider: cloudflareAccountId ? "letsencrypt-cloudflare" : "letsencrypt-http",
    cloudflareAccountId,
    status: "pending",
  });
  await enqueue("certificate.issue", { certificateId: id }, { concurrencyKey: `cert:${id}`, maxAttempts: 2 });
}

/**
 * Where the page's domain points now, and where it should. Behind Cloudflare's proxy the answer is
 * Cloudflare's addresses: a connected Cloudflare account tells the real target, else it is "proxied".
 */
export async function checkStatusDomain(pageId: string) {
  return act(async () => {
    const ctx = await requireStatusManager();
    const page = await pageInOrg(pageId, ctx.org.id);
    if (!page.domain) throw new UserError("The page has no domain.");
    const settings = await getSettings();
    const expected = settings.serverIp ?? null;
    const dns = await domainDnsStatus(page.domain, expected, { organizationId: ctx.org.id, tunnel: !!page.tunnelId }).catch(() => ({
      status: "unknown" as const,
      records: [] as string[],
    }));
    // Serve can set the record itself: a public IP route, a name a connected Cloudflare account manages.
    const canCreate =
      ctx.isAdmin && !page.tunnelId && !!expected && dns.status !== "ok" && dns.status !== "proxied" && !!(await cloudflareAccountFor([page.domain], ctx.org.id).catch(() => null));
    return { status: dns.status, records: dns.records, expected, canCreate };
  });
}

/** Create or set right the A record of the page's domain in Cloudflare (see pointStatusDomain). */
export async function createStatusRecord(pageId: string) {
  return act(async () => {
    const ctx = await requireStatusManager();
    const page = await pageInOrg(pageId, ctx.org.id);
    if (!ctx.isAdmin) throw new UserError("Only organization admins can create DNS records.");
    if (!page.domain || page.tunnelId) throw new UserError("Only a domain on the public IP route has an A record.");
    if (!(await cloudflareAccountFor([page.domain], ctx.org.id).catch(() => null)))
      throw new UserError(`No connected Cloudflare account manages ${page.domain}. Add the A record where its DNS is.`);
    const problem = await pointStatusDomain(ctx.org.id, page.domain);
    if (problem) throw new UserError(problem);
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "status-page.domain",
      message: `Created the A record of ${page.domain} for the status page ${page.name}`,
      targetType: "status-page",
      targetId: pageId,
    });
    return null;
  });
}

/* -------------------------------------------------------------------------- */
/*                                 Components                                 */
/* -------------------------------------------------------------------------- */

const componentInput = z.object({
  serviceId: z.string().nullable(),
  name: z.string().trim().min(1, "Give the component a name.").max(80),
  description: z.string().trim().max(300).nullable(),
  group: z.string().trim().max(60).nullable(),
});

/** The service must be the organization's: a page must not show another organization's checks. */
async function serviceOfOrg(serviceId: string, organizationId: string) {
  const [row] = await db
    .select({ id: schema.service.id })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(and(eq(schema.service.id, serviceId), eq(schema.project.organizationId, organizationId)));
  if (!row) throw new UserError("Service not found.");
}

export async function addStatusComponent(pageId: string, input: z.input<typeof componentInput>) {
  return act(async () => {
    const ctx = await requireStatusManager();
    await pageInOrg(pageId, ctx.org.id);
    const data = componentInput.parse(input);
    if (data.serviceId) await serviceOfOrg(data.serviceId, ctx.org.id);
    const existing = await db.select({ position: schema.statusComponent.position }).from(schema.statusComponent).where(eq(schema.statusComponent.pageId, pageId));
    const id = newId();
    await db.insert(schema.statusComponent).values({
      id,
      pageId,
      serviceId: data.serviceId,
      name: data.name,
      description: data.description || null,
      group: data.group || null,
      position: existing.reduce((a, c) => Math.max(a, c.position + 1), 0),
    });
    await touch(pageId);
    return { id };
  });
}

export async function updateStatusComponent(componentId: string, input: z.input<typeof componentInput>) {
  return act(async () => {
    const ctx = await requireStatusManager();
    const component = await componentOfOrg(componentId, ctx.org.id);
    const data = componentInput.parse(input);
    if (data.serviceId) await serviceOfOrg(data.serviceId, ctx.org.id);
    await db
      .update(schema.statusComponent)
      .set({ serviceId: data.serviceId, name: data.name, description: data.description || null, group: data.group || null })
      .where(eq(schema.statusComponent.id, componentId));
    await touch(component.pageId);
    return null;
  });
}

export async function removeStatusComponent(componentId: string) {
  return act(async () => {
    const ctx = await requireStatusManager();
    const component = await componentOfOrg(componentId, ctx.org.id);
    await db.delete(schema.statusComponent).where(eq(schema.statusComponent.id, componentId));
    await touch(component.pageId);
    return null;
  });
}

/** New order of a page's components: every id of the page, top first. */
export async function reorderStatusComponents(pageId: string, ids: string[]) {
  return act(async () => {
    const ctx = await requireStatusManager();
    await pageInOrg(pageId, ctx.org.id);
    const list = z.array(z.string()).parse(ids);
    const rows = await db.select({ id: schema.statusComponent.id }).from(schema.statusComponent).where(eq(schema.statusComponent.pageId, pageId));
    const known = new Set(rows.map((r) => r.id));
    if (list.length !== known.size || !list.every((id) => known.has(id))) throw new UserError("The components changed meanwhile. Reload the page and try again.");
    await db.transaction(async (tx) => {
      for (const [i, id] of list.entries()) await tx.update(schema.statusComponent).set({ position: i }).where(eq(schema.statusComponent.id, id));
    });
    await touch(pageId);
    return null;
  });
}

async function componentOfOrg(componentId: string, organizationId: string) {
  const [row] = await db
    .select({ id: schema.statusComponent.id, pageId: schema.statusComponent.pageId })
    .from(schema.statusComponent)
    .innerJoin(schema.statusPage, eq(schema.statusComponent.pageId, schema.statusPage.id))
    .where(and(eq(schema.statusComponent.id, componentId), eq(schema.statusPage.organizationId, organizationId)));
  if (!row) throw new UserError("Component not found.");
  return row;
}

/* -------------------------------------------------------------------------- */
/*                          Incidents and maintenance                         */
/* -------------------------------------------------------------------------- */

const date = z
  .string()
  .nullable()
  .transform((v, c) => {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      c.addIssue({ code: "custom", message: "Enter a valid date and time." });
      return z.NEVER;
    }
    return d;
  });

const noticeInput = z.object({
  kind: z.enum(["incident", "maintenance"]),
  title: z.string().trim().min(1, "Give it a title.").max(160),
  impact: z.enum(["minor", "major", "critical"]),
  state: z.enum(INCIDENT_STATES as [string, ...string[]]),
  componentIds: z.array(z.string()),
  body: z.string().trim().max(5000),
  startsAt: date,
  endsAt: date,
  /** Tell subscribers (default). Team channels hear every post. */
  notify: z.boolean().optional(),
  /** Only these subscriber types; left out: every type the page offers. */
  kinds: z.array(z.enum(["email", "slack", "discord", "webhook"])).nullish(),
  /** Only these team channels; left out: the page's own. */
  channels: z.array(z.string()).nullish(),
});

/** The organization's channels picked for one post (unknown ids are an error, not a silent skip). */
async function orgChannels(organizationId: string, ids: string[] | null | undefined) {
  if (!ids) return null;
  const wanted = [...new Set(ids)];
  if (!wanted.length) return [];
  const rows = await db
    .select({ id: schema.notificationChannel.id })
    .from(schema.notificationChannel)
    .where(and(eq(schema.notificationChannel.organizationId, organizationId), inArray(schema.notificationChannel.id, wanted)));
  if (rows.length !== wanted.length) throw new UserError("A notification channel was not found.");
  return wanted;
}

async function onlyPageComponents(pageId: string, ids: string[]) {
  if (!ids.length) return [];
  const rows = await db
    .select({ id: schema.statusComponent.id })
    .from(schema.statusComponent)
    .where(and(eq(schema.statusComponent.pageId, pageId), inArray(schema.statusComponent.id, ids)));
  return rows.map((r) => r.id);
}

/** Post an incident (with its first message) or plan a maintenance window. */
export async function createStatusNotice(pageId: string, input: z.input<typeof noticeInput>) {
  return act(async () => {
    const ctx = await requireStatusManager();
    await pageInOrg(pageId, ctx.org.id);
    const data = noticeInput.parse(input);
    if (data.kind === "maintenance") {
      if (!data.startsAt || !data.endsAt) throw new UserError("Set when the maintenance starts and ends.");
      if (data.endsAt <= data.startsAt) throw new UserError("The maintenance must end after it starts.");
    }
    if (data.kind === "incident" && !data.body) throw new UserError("Write what is happening: visitors read this first.");
    // Checked before anything is saved: a wrong channel must not leave a posted incident behind.
    const channels = await orgChannels(ctx.org.id, data.channels);
    const id = newId();
    const resolved = data.kind === "incident" && data.state === "resolved";
    await db.transaction(async (tx) => {
      await tx.insert(schema.statusNotice).values({
        id,
        pageId,
        kind: data.kind,
        title: data.title,
        impact: data.impact,
        state: data.kind === "incident" ? (data.state as (typeof INCIDENT_STATES)[number]) : "investigating",
        componentIds: await onlyPageComponents(pageId, data.componentIds),
        startsAt: data.kind === "maintenance" ? data.startsAt : (data.startsAt ?? new Date()),
        endsAt: data.kind === "maintenance" ? data.endsAt : null,
        resolvedAt: resolved ? new Date() : null,
        // A window that already started is announced as posted, not once more by the minute tick.
        startNotified: data.kind === "maintenance" && !!data.startsAt && data.startsAt <= new Date(),
        createdBy: ctx.user.id,
      });
      if (data.body) await tx.insert(schema.statusNoticeUpdate).values({ id: newId(), noticeId: id, state: data.kind === "incident" ? data.state : "scheduled", body: data.body });
    });
    await touch(pageId);
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: data.kind === "incident" ? "status-page.incident" : "status-page.maintenance",
      message: `${data.kind === "incident" ? "Posted the incident" : "Planned the maintenance"} ${data.title}`,
      targetType: "status-page",
      targetId: pageId,
    });
    await enqueue("status.notify", { noticeId: id, event: "created", notify: data.notify ?? true, kinds: data.kinds ?? null, channels }, { maxAttempts: 1 });
    return { id };
  });
}

/** A new message on an incident; "resolved" closes it. Maintenance messages keep its times. */
export async function addStatusUpdate(
  noticeId: string,
  input: { state: string; body: string; notify?: boolean; kinds?: ("email" | "slack" | "discord" | "webhook")[] | null; channels?: string[] | null },
) {
  return act(async () => {
    const ctx = await requireStatusManager();
    const notice = await noticeOfOrg(noticeId, ctx.org.id);
    const data = z
      .object({
        state: z.enum(["investigating", "identified", "monitoring", "resolved", "scheduled", "in-progress", "completed"]),
        body: z.string().trim().min(1, "Write the update.").max(5000),
        notify: z.boolean().optional(),
        kinds: noticeInput.shape.kinds,
        channels: noticeInput.shape.channels,
      })
      .parse(input);
    const channels = await orgChannels(ctx.org.id, data.channels);
    const patch: Partial<typeof schema.statusNotice.$inferInsert> = {};
    if (notice.kind === "incident") {
      if (!(INCIDENT_STATES as string[]).includes(data.state)) throw new UserError("Pick the incident's state.");
      patch.state = data.state as (typeof INCIDENT_STATES)[number];
      patch.resolvedAt = data.state === "resolved" ? (notice.resolvedAt ?? new Date()) : null;
    } else if (data.state === "completed") {
      patch.resolvedAt = notice.resolvedAt ?? new Date();
      // This update says it: the minute tick must not announce the start or the end again.
      patch.startNotified = true;
      patch.endNotified = true;
    } else if (data.state === "in-progress") {
      patch.startNotified = true;
    }
    await db.transaction(async (tx) => {
      if (Object.keys(patch).length) await tx.update(schema.statusNotice).set(patch).where(eq(schema.statusNotice.id, noticeId));
      await tx.insert(schema.statusNoticeUpdate).values({ id: newId(), noticeId, state: data.state, body: data.body });
    });
    await touch(notice.pageId);
    await enqueue("status.notify", { noticeId, event: "updated", notify: data.notify ?? true, kinds: data.kinds ?? null, channels }, { maxAttempts: 1 });
    return null;
  });
}

/** Change an incident's title, impact, components or times (typos, a wider outage than first thought). */
export async function editStatusNotice(
  noticeId: string,
  input: { title: string; impact: string; componentIds: string[]; startsAt: string | null; endsAt: string | null; postmortem?: string | null },
) {
  return act(async () => {
    const ctx = await requireStatusManager();
    const notice = await noticeOfOrg(noticeId, ctx.org.id);
    const data = z
      .object({
        title: noticeInput.shape.title,
        impact: noticeInput.shape.impact,
        componentIds: z.array(z.string()),
        startsAt: date,
        endsAt: date,
        postmortem: z.string().max(20_000).nullish(),
      })
      .parse(input);
    if (notice.kind === "maintenance") {
      if (!data.startsAt || !data.endsAt) throw new UserError("Set when the maintenance starts and ends.");
      if (data.endsAt <= data.startsAt) throw new UserError("The maintenance must end after it starts.");
    }
    await db
      .update(schema.statusNotice)
      .set({
        title: data.title,
        impact: data.impact,
        componentIds: await onlyPageComponents(notice.pageId, data.componentIds),
        ...(data.startsAt ? { startsAt: data.startsAt } : {}),
        ...(notice.kind === "maintenance" ? { endsAt: data.endsAt } : {}),
        ...(data.postmortem !== undefined ? { postmortem: data.postmortem?.trim() || null } : {}),
      })
      .where(eq(schema.statusNotice.id, noticeId));
    await touch(notice.pageId);
    return null;
  });
}

export async function deleteStatusNotice(noticeId: string) {
  return act(async () => {
    const ctx = await requireStatusManager();
    const notice = await noticeOfOrg(noticeId, ctx.org.id);
    await db.delete(schema.statusNotice).where(eq(schema.statusNotice.id, noticeId));
    await touch(notice.pageId);
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "status-page.notice-delete",
      message: `Deleted ${notice.title} from a status page`,
      targetType: "status-page",
      targetId: notice.pageId,
    });
    return null;
  });
}

/* -------------------------------------------------------------------------- */
/*                                  Templates                                 */
/* -------------------------------------------------------------------------- */

const templateInput = z.object({
  name: z.string().trim().min(1, "Name the template.").max(60),
  title: z.string().trim().max(160),
  impact: z.enum(["minor", "major", "critical"]),
  body: z.string().trim().max(5000),
});

/** Save an incident message to reuse; a template with the same name is replaced. */
export async function saveStatusTemplate(pageId: string, input: z.input<typeof templateInput>) {
  return act(async () => {
    const ctx = await requireStatusManager();
    await pageInOrg(pageId, ctx.org.id);
    const data = templateInput.parse(input);
    const [row] = await db.select({ templates: schema.statusPage.templates }).from(schema.statusPage).where(eq(schema.statusPage.id, pageId));
    const rest = (row?.templates ?? []).filter((t) => t.name.toLowerCase() !== data.name.toLowerCase());
    await db
      .update(schema.statusPage)
      .set({ templates: [...rest, { id: newId(), ...data }].sort((a, b) => a.name.localeCompare(b.name)) })
      .where(eq(schema.statusPage.id, pageId));
    return null;
  });
}

export async function deleteStatusTemplate(pageId: string, templateId: string) {
  return act(async () => {
    const ctx = await requireStatusManager();
    await pageInOrg(pageId, ctx.org.id);
    const [row] = await db.select({ templates: schema.statusPage.templates }).from(schema.statusPage).where(eq(schema.statusPage.id, pageId));
    await db
      .update(schema.statusPage)
      .set({ templates: (row?.templates ?? []).filter((t) => t.id !== templateId) })
      .where(eq(schema.statusPage.id, pageId));
    return null;
  });
}

async function noticeOfOrg(noticeId: string, organizationId: string) {
  const [row] = await db
    .select({ notice: schema.statusNotice })
    .from(schema.statusNotice)
    .innerJoin(schema.statusPage, eq(schema.statusNotice.pageId, schema.statusPage.id))
    .where(and(eq(schema.statusNotice.id, noticeId), eq(schema.statusPage.organizationId, organizationId)));
  if (!row) throw new UserError("Not found.");
  return row.notice;
}

/* -------------------------------------------------------------------------- */
/*                         Subscribers and team channels                       */
/* -------------------------------------------------------------------------- */

const subscribeInput = z.object({
  email: z.boolean(),
  slack: z.boolean(),
  discord: z.boolean(),
  webhook: z.boolean(),
  rss: z.boolean(),
  components: z.boolean(),
  outages: z.boolean(),
});

/** Which ways to subscribe the page offers, and the team channels that get every post. */
export async function saveStatusSubscriptions(pageId: string, input: { subscribe: z.input<typeof subscribeInput>; teamChannelIds: string[] }) {
  return act(async () => {
    const ctx = await requireStatusManager();
    const page = await pageInOrg(pageId, ctx.org.id);
    const subscribe = subscribeInput.parse(input.subscribe);
    const wanted = (await orgChannels(ctx.org.id, z.array(z.string()).parse(input.teamChannelIds))) ?? [];
    await db.update(schema.statusPage).set({ subscribe, teamChannelIds: wanted, updatedAt: new Date() }).where(eq(schema.statusPage.id, pageId));
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "status-page.update",
      message: `Changed the subscriptions of the status page ${page.name}`,
      targetType: "status-page",
      targetId: pageId,
    });
    return null;
  });
}

export async function removeStatusSubscriber(subscriberId: string) {
  return act(async () => {
    const ctx = await requireStatusManager();
    const [row] = await db
      .select({ id: schema.statusSubscriber.id })
      .from(schema.statusSubscriber)
      .innerJoin(schema.statusPage, eq(schema.statusSubscriber.pageId, schema.statusPage.id))
      .where(and(eq(schema.statusSubscriber.id, subscriberId), eq(schema.statusPage.organizationId, ctx.org.id)));
    if (!row) throw new UserError("Subscriber not found.");
    await db.delete(schema.statusSubscriber).where(eq(schema.statusSubscriber.id, subscriberId));
    return null;
  });
}

/** More subscribers for the list, or a search (email addresses; webhooks by type only). */
export async function listStatusSubscribers(pageId: string, input: { q?: string; kind?: string; offset?: number }) {
  return act(async () => {
    const ctx = await requireStatusManager();
    await pageInOrg(pageId, ctx.org.id);
    const data = z
      .object({ q: z.string().max(200).optional(), kind: z.enum(["email", "slack", "discord", "webhook"]).optional(), offset: z.number().int().min(0).max(1_000_000).optional() })
      .parse(input);
    const { subscriberRows } = await import("@/server/status-pages/admin");
    return subscriberRows(pageId, data);
  });
}
