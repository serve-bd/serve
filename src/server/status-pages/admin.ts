import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LOCAL_SERVER_ID } from "@/server/db/schema";
import { publicBaseUrl } from "@/server/git/github-app";
import { getSettings } from "@/server/settings";
import { certificateCovers } from "@/server/ssl/match";
import { designOf } from "@/lib/status-page";
import { pageColumns, statusView } from "./data";

export async function pageUrl(page: { slug: string; domain: string | null; https: boolean }) {
  if (page.domain) return `${page.https ? "https" : "http"}://${page.domain}`;
  return `${await publicBaseUrl()}/status/${page.slug}`;
}

/** The organization's pages for the list. */
export async function orgStatusPages(organizationId: string) {
  const pages = await db.select(pageColumns).from(schema.statusPage).where(eq(schema.statusPage.organizationId, organizationId)).orderBy(asc(schema.statusPage.name));
  if (!pages.length) return [];
  const ids = pages.map((p) => p.id);
  const [components, open] = await Promise.all([
    db
      .select({ pageId: schema.statusComponent.pageId, n: count() })
      .from(schema.statusComponent)
      .where(inArray(schema.statusComponent.pageId, ids))
      .groupBy(schema.statusComponent.pageId),
    db
      .select({ pageId: schema.statusNotice.pageId, n: count() })
      .from(schema.statusNotice)
      .where(and(inArray(schema.statusNotice.pageId, ids), eq(schema.statusNotice.kind, "incident"), isNull(schema.statusNotice.resolvedAt)))
      .groupBy(schema.statusNotice.pageId),
  ]);
  return Promise.all(
    pages.map(async (p) => {
      const view = await statusView(p, `/status/${p.slug}`, { ...designOf(p.design), autoIncidents: true, historyDays: 0, days: 30 });
      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        domain: p.domain,
        visibility: p.visibility,
        url: await pageUrl(p),
        components: components.find((c) => c.pageId === p.id)?.n ?? 0,
        openIncidents: open.find((c) => c.pageId === p.id)?.n ?? 0,
        overall: view.overall,
      };
    }),
  );
}

export type EditorService = { id: string; name: string; project: string; check: "up" | "down" | "pending" | "paused" | null };

/** Everything the editor shows. Null when the page is not the organization's. */
export async function editorData(pageId: string, organizationId: string) {
  const [page] = await db
    .select({ ...pageColumns, images: schema.statusPage.images, templates: schema.statusPage.templates })
    .from(schema.statusPage)
    .where(and(eq(schema.statusPage.id, pageId), eq(schema.statusPage.organizationId, organizationId)));
  if (!page) return null;
  const base = `/status/${page.slug}`;
  const design = designOf(page.design);
  const [components, services, notices, settings, view, local] = await Promise.all([
    db.select().from(schema.statusComponent).where(eq(schema.statusComponent.pageId, pageId)).orderBy(asc(schema.statusComponent.position)),
    db
      .select({ id: schema.service.id, name: schema.service.name, project: schema.project.name, status: schema.monitor.status, enabled: schema.monitor.enabled })
      .from(schema.service)
      .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
      .leftJoin(schema.monitor, eq(schema.monitor.serviceId, schema.service.id))
      .where(eq(schema.project.organizationId, organizationId))
      .orderBy(asc(schema.project.name), asc(schema.service.name)),
    db.select().from(schema.statusNotice).where(eq(schema.statusNotice.pageId, pageId)).orderBy(desc(schema.statusNotice.createdAt)).limit(100),
    getSettings(),
    // Always with response times: the preview shows the chart as soon as its switch is on, before saving.
    statusView(page, base, { ...design, showLatency: true }),
    db.select({ kind: schema.server.proxyKind }).from(schema.server).where(eq(schema.server.id, LOCAL_SERVER_ID)),
  ]);
  const updates = notices.length
    ? await db
        .select()
        .from(schema.statusNoticeUpdate)
        .where(
          inArray(
            schema.statusNoticeUpdate.noticeId,
            notices.map((n) => n.id),
          ),
        )
        .orderBy(desc(schema.statusNoticeUpdate.createdAt))
    : [];
  // Certificates and tunnels the page's domain can use: the organization's, on the dashboard's server.
  const [certificates, tunnels] = await Promise.all([
    db
      .select({
        id: schema.certificate.id,
        name: schema.certificate.name,
        provider: schema.certificate.provider,
        status: schema.certificate.status,
        error: schema.certificate.lastError,
        domains: schema.certificate.domains,
        expiresAt: schema.certificate.expiresAt,
      })
      .from(schema.certificate)
      .where(and(eq(schema.certificate.organizationId, organizationId), eq(schema.certificate.serverId, LOCAL_SERVER_ID))),
    db
      .select({ id: schema.cloudflareTunnel.id, name: schema.cloudflareTunnel.name, status: schema.cloudflareTunnel.status, account: schema.cloudflareAccount.name })
      .from(schema.cloudflareTunnel)
      .innerJoin(schema.cloudflareAccount, eq(schema.cloudflareTunnel.cloudflareAccountId, schema.cloudflareAccount.id))
      .where(and(eq(schema.cloudflareTunnel.organizationId, organizationId), eq(schema.cloudflareTunnel.serverId, LOCAL_SERVER_ID))),
  ]);
  const certificate = page.domain ? (certificates.find((c) => c.id === page.certificateId) ?? certificates.find((c) => certificateCovers(c.domains, page.domain!))) : undefined;

  const serviceRows: EditorService[] = services.map((s) => ({ id: s.id, name: s.name, project: s.project, check: s.status ? (s.enabled ? s.status : "paused") : null }));
  return {
    page: {
      id: page.id,
      name: page.name,
      slug: page.slug,
      domain: page.domain,
      https: page.https,
      tunnelId: page.tunnelId,
      certificateId: page.certificateId,
      visibility: page.visibility,
      hasPassword: !!page.passwordHash,
      url: await pageUrl(page),
      dashboardUrl: `${await publicBaseUrl()}${base}`,
    },
    design,
    logos: {
      logo: page.images.logo ? `${base}/logo?v=${page.images.logo.hash}` : null,
      logoDark: page.images.logoDark ? `${base}/logo?dark=1&v=${page.images.logoDark.hash}` : null,
      favicon: page.images.favicon ? `${base}/icon?v=${page.images.favicon.hash}` : null,
    },
    components: components.map((c) => ({ id: c.id, serviceId: c.serviceId, name: c.name, description: c.description, group: c.group })),
    services: serviceRows,
    notices: notices.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      impact: n.impact,
      state: n.state,
      componentIds: n.componentIds,
      startsAt: n.startsAt?.toISOString() ?? null,
      endsAt: n.endsAt?.toISOString() ?? null,
      resolvedAt: n.resolvedAt?.toISOString() ?? null,
      postmortem: n.postmortem,
      createdAt: n.createdAt.toISOString(),
      updates: updates.filter((u) => u.noticeId === n.id).map((u) => ({ id: u.id, state: u.state, body: u.body, at: u.createdAt.toISOString() })),
    })),
    view,
    templates: page.templates,
    domain: {
      serverIp: settings.serverIp ?? null,
      proxy: local[0]?.kind ?? "nginx",
      acme: !!settings.acmeEmail,
      certificate: certificate ? { name: certificate.name, status: certificate.status, error: certificate.error } : null,
      certificates: certificates.map((c) => ({
        id: c.id,
        name: c.name,
        provider: c.provider,
        status: c.status,
        domains: c.domains,
        expiresAt: c.expiresAt?.toISOString() ?? null,
      })),
      tunnels: tunnels.map((t) => ({ id: t.id, name: t.name, status: t.status, account: t.account })),
    },
  };
}

export type EditorData = NonNullable<Awaited<ReturnType<typeof editorData>>>;
