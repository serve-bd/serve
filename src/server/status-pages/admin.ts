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
    .select({ ...pageColumns, images: schema.statusPage.images })
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
    statusView(page, base, design),
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
  const certificate = page.domain
    ? (
        await db
          .select({ id: schema.certificate.id, status: schema.certificate.status, error: schema.certificate.lastError, domains: schema.certificate.domains })
          .from(schema.certificate)
          .where(and(eq(schema.certificate.organizationId, organizationId), eq(schema.certificate.serverId, LOCAL_SERVER_ID)))
      ).find((c) => certificateCovers(c.domains, page.domain!))
    : undefined;

  const serviceRows: EditorService[] = services.map((s) => ({ id: s.id, name: s.name, project: s.project, check: s.status ? (s.enabled ? s.status : "paused") : null }));
  return {
    page: {
      id: page.id,
      name: page.name,
      slug: page.slug,
      domain: page.domain,
      https: page.https,
      visibility: page.visibility,
      hasPassword: !!page.passwordHash,
      url: await pageUrl(page),
      dashboardUrl: `${await publicBaseUrl()}${base}`,
    },
    design,
    logos: {
      logo: page.images.logo ? `${base}/logo?v=${page.images.logo.hash}` : null,
      logoDark: page.images.logoDark ? `${base}/logo?dark=1&v=${page.images.logoDark.hash}` : null,
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
      createdAt: n.createdAt.toISOString(),
      updates: updates.filter((u) => u.noticeId === n.id).map((u) => ({ id: u.id, state: u.state, body: u.body, at: u.createdAt.toISOString() })),
    })),
    view,
    domain: {
      serverIp: settings.serverIp ?? null,
      proxy: local[0]?.kind ?? "nginx",
      acme: !!settings.acmeEmail,
      certificate: certificate ? { status: certificate.status, error: certificate.error } : null,
    },
  };
}

export type EditorData = NonNullable<Awaited<ReturnType<typeof editorData>>>;
