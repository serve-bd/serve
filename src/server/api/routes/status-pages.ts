import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import * as actions from "@/server/actions/status-pages";
import type { ApiAuth } from "@/server/api-auth";
import { db, schema } from "@/server/db";
import { pageUrl } from "@/server/status-pages/urls";
import { defaultDesign, designOf, SUBSCRIBER_KINDS } from "@/lib/status-page";
import { ApiError, type ApiRoute, route, unwrap } from "../router";

/*
 * Status pages: post and update incidents and maintenance from CI and scripts (a deploy that
 * starts maintenance, an alert that opens an incident). The same rules as the dashboard apply.
 */

async function pageOf(pageId: string, organizationId: string) {
  const [page] = await db
    .select({
      id: schema.statusPage.id,
      name: schema.statusPage.name,
      slug: schema.statusPage.slug,
      domain: schema.statusPage.domain,
      https: schema.statusPage.https,
      visibility: schema.statusPage.visibility,
    })
    .from(schema.statusPage)
    .where(and(eq(schema.statusPage.id, pageId), eq(schema.statusPage.organizationId, organizationId)));
  if (!page) throw new ApiError(404, "Status page not found");
  return page;
}

/** A notice of the page in the path: an id of another page is not found here. */
async function noticeOf(pageId: string, noticeId: string, organizationId: string) {
  await pageOf(pageId, organizationId);
  const [row] = await db
    .select({ id: schema.statusNotice.id })
    .from(schema.statusNotice)
    .where(and(eq(schema.statusNotice.id, noticeId), eq(schema.statusNotice.pageId, pageId)));
  if (!row) throw new ApiError(404, "Incident not found");
}

async function noticesOf(pageId: string, filter: { open?: boolean; limit?: number; id?: string }) {
  const rows = await db
    .select()
    .from(schema.statusNotice)
    .where(and(eq(schema.statusNotice.pageId, pageId), filter.id ? eq(schema.statusNotice.id, filter.id) : undefined))
    .orderBy(desc(schema.statusNotice.createdAt))
    .limit(Math.min(filter.limit ?? 50, 200));
  const list = filter.open ? rows.filter((n) => !n.resolvedAt && (n.kind === "incident" || !n.endsAt || n.endsAt > new Date())) : rows;
  const updates = list.length
    ? await db
        .select()
        .from(schema.statusNoticeUpdate)
        .where(
          inArray(
            schema.statusNoticeUpdate.noticeId,
            list.map((n) => n.id),
          ),
        )
        .orderBy(asc(schema.statusNoticeUpdate.createdAt))
    : [];
  return list.map((n) => ({
    id: n.id,
    kind: n.kind,
    title: n.title,
    impact: n.impact,
    state: n.kind === "incident" ? n.state : null,
    componentIds: n.componentIds,
    startsAt: n.startsAt?.toISOString() ?? null,
    endsAt: n.endsAt?.toISOString() ?? null,
    resolvedAt: n.resolvedAt?.toISOString() ?? null,
    postmortem: n.postmortem,
    createdAt: n.createdAt.toISOString(),
    updates: updates.filter((u) => u.noticeId === n.id).map((u) => ({ state: u.state, body: u.body, createdAt: u.createdAt.toISOString() })),
  }));
}

/** Status pages span every project, so a token limited to some projects cannot manage them (as in the dashboard). */
function allProjects(auth: ApiAuth) {
  if (auth.projectIds) throw new ApiError(403, "Status pages span every project: only tokens with access to all projects manage them.");
}

/** A page with its settings: never its password hash or the uploaded images themselves. */
async function pageView(pageId: string, organizationId: string) {
  const [p] = await db
    .select()
    .from(schema.statusPage)
    .where(and(eq(schema.statusPage.id, pageId), eq(schema.statusPage.organizationId, organizationId)));
  if (!p) throw new ApiError(404, "Status page not found");
  const { logo: _logo, logoDark: _logoDark, ...design } = designOf(p.design);
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    url: await pageUrl(p),
    domain: p.domain,
    https: p.https,
    tunnelId: p.tunnelId,
    certificateId: p.certificateId,
    visibility: p.visibility,
    hasPassword: !!p.passwordHash,
    design,
    images: Object.fromEntries(Object.entries(p.images ?? {}).map(([k, v]) => [k, v ? { hash: v.hash, mime: v.mime } : null])),
    subscribe: p.subscribe,
    teamChannelIds: p.teamChannelIds,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** Look fields a PATCH may change: everything but the logos, which the dashboard uploads. */
const DESIGN_KEYS = Object.keys(defaultDesign).filter((k) => k !== "logo" && k !== "logoDark");

async function componentOf(pageId: string, componentId: string) {
  const [c] = await db
    .select()
    .from(schema.statusComponent)
    .where(and(eq(schema.statusComponent.id, componentId), eq(schema.statusComponent.pageId, pageId)));
  if (!c) throw new ApiError(404, "Component not found");
  return c;
}

const componentView = (c: typeof schema.statusComponent.$inferSelect) => ({
  id: c.id,
  name: c.name,
  description: c.description,
  group: c.group,
  serviceId: c.serviceId,
  position: c.position,
});

const STATES = ["investigating", "identified", "monitoring", "resolved"] as const;
const impact = z.enum(["minor", "major", "critical"]);
const when = z.string().describe("ISO 8601 time, like 2026-10-06T22:00:00Z");

export const statusPageRoutes: ApiRoute[] = [
  route({
    method: "GET",
    path: "/status-pages",
    tag: "Status pages",
    summary: "List status pages",
    needs: ["status-pages.manage"],
    handler: async ({ auth }) => {
      const pages = await db
        .select({
          id: schema.statusPage.id,
          name: schema.statusPage.name,
          slug: schema.statusPage.slug,
          domain: schema.statusPage.domain,
          https: schema.statusPage.https,
          tunnelId: schema.statusPage.tunnelId,
          visibility: schema.statusPage.visibility,
        })
        .from(schema.statusPage)
        .where(eq(schema.statusPage.organizationId, auth.organizationId))
        .orderBy(asc(schema.statusPage.name));
      return { statusPages: await Promise.all(pages.map(async ({ https, tunnelId, ...p }) => ({ ...p, url: await pageUrl({ ...p, https, tunnelId }) }))) };
    },
  }),
  route({
    method: "GET",
    path: "/status-pages/{pageId}/components",
    tag: "Status pages",
    summary: "List a page's components",
    description: "Their ids are what incidents and maintenance take in componentIds.",
    needs: ["status-pages.manage"],
    handler: async ({ auth, params }) => {
      await pageOf(params.pageId, auth.organizationId);
      const rows = await db
        .select({ id: schema.statusComponent.id, name: schema.statusComponent.name, group: schema.statusComponent.group, serviceId: schema.statusComponent.serviceId })
        .from(schema.statusComponent)
        .where(eq(schema.statusComponent.pageId, params.pageId))
        .orderBy(asc(schema.statusComponent.position));
      return { components: rows };
    },
  }),
  route({
    method: "GET",
    path: "/status-pages/{pageId}/incidents",
    tag: "Status pages",
    summary: "List incidents and maintenance",
    description: "Newest first, with every update. open=true lists only ongoing incidents and maintenance that has not ended.",
    needs: ["status-pages.manage"],
    query: z.object({ open: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }),
    handler: async ({ auth, params, query }) => {
      await pageOf(params.pageId, auth.organizationId);
      return { incidents: await noticesOf(params.pageId, { open: query.open === "true", limit: query.limit }) };
    },
  }),
  route({
    method: "POST",
    path: "/status-pages/{pageId}/incidents",
    tag: "Status pages",
    summary: "Report an incident or plan maintenance",
    description:
      "kind incident needs a message (body); kind maintenance needs startsAt and endsAt. Subscribers are told unless notify is false (subscriberTypes picks which types); the page's team channels always are, unless channels names others ([] for none).",
    needs: ["status-pages.manage"],
    status: 201,
    body: z.object({
      kind: z.enum(["incident", "maintenance"]).default("incident"),
      title: z.string(),
      body: z.string().default(""),
      impact: impact.default("major"),
      state: z.enum(STATES).default("investigating"),
      componentIds: z.array(z.string()).default([]),
      startsAt: when.optional(),
      endsAt: when.optional(),
      notify: z.boolean().default(true),
      subscriberTypes: z
        .array(z.enum(["email", "slack", "discord", "webhook"]))
        .optional()
        .describe("Only these subscriber types; left out: every type the page offers"),
      channels: z.array(z.string()).optional().describe("Only these notification channel ids; left out: the page's team channels; [] for none"),
    }),
    handler: async ({ auth, params, body }) => {
      await pageOf(params.pageId, auth.organizationId);
      const { id } = await unwrap(
        actions.createStatusNotice(params.pageId, {
          kind: body.kind,
          title: body.title,
          body: body.body,
          impact: body.impact,
          state: body.state,
          componentIds: body.componentIds,
          startsAt: body.startsAt ?? null,
          endsAt: body.endsAt ?? null,
          notify: body.notify,
          kinds: body.subscriberTypes ?? null,
          channels: body.channels ?? null,
        }),
      );
      return (await noticesOf(params.pageId, { id: id }))[0];
    },
  }),
  route({
    method: "POST",
    path: "/status-pages/{pageId}/incidents/{incidentId}/updates",
    tag: "Status pages",
    summary: "Post an update",
    description:
      "For an incident, state is investigating, identified, monitoring or resolved (resolved closes it). For maintenance: scheduled, in-progress or completed (completed ends it now).",
    needs: ["status-pages.manage"],
    status: 201,
    body: z.object({
      state: z.enum([...STATES, "scheduled", "in-progress", "completed"]),
      body: z.string(),
      notify: z.boolean().default(true),
      subscriberTypes: z
        .array(z.enum(["email", "slack", "discord", "webhook"]))
        .optional()
        .describe("Only these subscriber types; left out: every type the page offers"),
      channels: z.array(z.string()).optional().describe("Only these notification channel ids; left out: the page's team channels; [] for none"),
    }),
    handler: async ({ auth, params, body }) => {
      await noticeOf(params.pageId, params.incidentId, auth.organizationId);
      await unwrap(
        actions.addStatusUpdate(params.incidentId, {
          state: body.state,
          body: body.body,
          notify: body.notify,
          kinds: body.subscriberTypes ?? null,
          channels: body.channels ?? null,
        }),
      );
      return (await noticesOf(params.pageId, { id: params.incidentId }))[0];
    },
  }),
  route({
    method: "PATCH",
    path: "/status-pages/{pageId}/incidents/{incidentId}",
    tag: "Status pages",
    summary: "Change an incident or maintenance",
    description: "Fields left out keep their value. Nobody is notified: post an update for news.",
    needs: ["status-pages.manage"],
    body: z.object({
      title: z.string().optional(),
      impact: impact.optional(),
      componentIds: z.array(z.string()).optional(),
      startsAt: when.optional(),
      endsAt: when.optional(),
      postmortem: z.string().nullable().optional(),
    }),
    handler: async ({ auth, params, body }) => {
      await noticeOf(params.pageId, params.incidentId, auth.organizationId);
      const current = (await noticesOf(params.pageId, { id: params.incidentId }))[0];
      if (!current) throw new ApiError(404, "Incident not found");
      await unwrap(
        actions.editStatusNotice(params.incidentId, {
          title: body.title ?? current.title,
          impact: body.impact ?? current.impact,
          componentIds: body.componentIds ?? current.componentIds,
          startsAt: body.startsAt ?? current.startsAt,
          endsAt: body.endsAt ?? current.endsAt,
          ...(body.postmortem !== undefined ? { postmortem: body.postmortem } : {}),
        }),
      );
      return (await noticesOf(params.pageId, { id: params.incidentId }))[0];
    },
  }),
  route({
    method: "DELETE",
    path: "/status-pages/{pageId}/incidents/{incidentId}",
    tag: "Status pages",
    summary: "Delete an incident or maintenance",
    description: "It goes from the page and its history, with every update.",
    needs: ["status-pages.manage"],
    handler: async ({ auth, params }) => {
      await noticeOf(params.pageId, params.incidentId, auth.organizationId);
      await unwrap(actions.deleteStatusNotice(params.incidentId));
      return { deleted: true };
    },
  }),
  route({
    method: "POST",
    path: "/status-pages",
    tag: "Status pages",
    summary: "Create a status page",
    description:
      "It starts as a draft (unpublished) at /status/<slug> on the dashboard's domain, with a component for each uptime check of the organization. Without slug, a free one is made from the name.",
    needs: ["status-pages.manage"],
    status: 201,
    body: z.object({ name: z.string(), slug: z.string().optional() }),
    handler: async ({ auth, body }) => {
      allProjects(auth);
      const { id } = await unwrap(actions.createStatusPage({ name: body.name, slug: body.slug }));
      return { statusPage: await pageView(id, auth.organizationId) };
    },
  }),
  route({
    method: "GET",
    path: "/status-pages/{pageId}",
    tag: "Status pages",
    summary: "Get a status page and its settings",
    description: "The look (design), the ways to subscribe, the team channels and the domain. Never the password: hasPassword says whether one is set.",
    needs: ["status-pages.manage"],
    handler: async ({ auth, params }) => {
      allProjects(auth);
      return { statusPage: await pageView(params.pageId, auth.organizationId) };
    },
  }),
  route({
    method: "PATCH",
    path: "/status-pages/{pageId}",
    tag: "Status pages",
    summary: "Change a status page's name, address or look",
    description: `Fields left out keep their value, and so do the fields of design left out. design takes: ${DESIGN_KEYS.join(", ")}. Logos are uploaded in the dashboard.`,
    needs: ["status-pages.manage"],
    body: z.object({
      name: z.string().optional(),
      slug: z.string().optional(),
      design: z
        .record(z.string(), z.unknown())
        .refine((d) => Object.keys(d).every((k) => DESIGN_KEYS.includes(k)), { message: `Unknown field. design takes: ${DESIGN_KEYS.join(", ")}` })
        .optional(),
    }),
    handler: async ({ auth, params, body }) => {
      allProjects(auth);
      const current = await pageView(params.pageId, auth.organizationId);
      await unwrap(
        actions.saveStatusPage(params.pageId, {
          name: body.name ?? current.name,
          slug: body.slug ?? current.slug,
          design: { ...current.design, ...(body.design as Partial<typeof current.design>) },
        }),
      );
      return { statusPage: await pageView(params.pageId, auth.organizationId) };
    },
  }),
  route({
    method: "DELETE",
    path: "/status-pages/{pageId}",
    tag: "Status pages",
    summary: "Delete a status page",
    description: "With its components, incidents and subscribers. Its domain stops serving it.",
    needs: ["status-pages.manage"],
    handler: async ({ auth, params }) => {
      allProjects(auth);
      await pageOf(params.pageId, auth.organizationId);
      await unwrap(actions.deleteStatusPage(params.pageId));
      return { deleted: true };
    },
  }),
  route({
    method: "PUT",
    path: "/status-pages/{pageId}/domain",
    tag: "Status pages",
    summary: "Set a status page's own domain",
    description:
      "domain null (or empty) takes the page off its domain. The domain must be verified for the organization. https: true gets a Let's Encrypt certificate unless certificateId names one of the organization's on the dashboard's server. tunnelId serves it through a Cloudflare Tunnel on the dashboard's server instead. Without a tunnel, Serve creates the A record when a connected Cloudflare account manages the name; warning says why it could not.",
    needs: ["status-pages.manage"],
    body: z.object({
      domain: z.string().nullable(),
      https: z.boolean().default(true),
      tunnelId: z.string().nullable().optional(),
      certificateId: z.string().nullable().optional(),
    }),
    handler: async ({ auth, params, body }) => {
      allProjects(auth);
      await pageOf(params.pageId, auth.organizationId);
      const done = await unwrap(
        actions.setStatusDomain(params.pageId, { domain: body.domain ?? "", https: body.https, tunnelId: body.tunnelId ?? null, certificateId: body.certificateId ?? null }),
      );
      // A DNS record a connected Cloudflare account could not take is said, not hidden.
      return { statusPage: await pageView(params.pageId, auth.organizationId), ...(done ?? {}) };
    },
  }),
  route({
    method: "PUT",
    path: "/status-pages/{pageId}/visibility",
    tag: "Status pages",
    summary: "Publish, unpublish or password-protect a status page",
    description: "visibility password needs a password (6 characters or more), unless one is set already. A new password replaces the old one.",
    needs: ["status-pages.manage"],
    body: z.object({ visibility: z.enum(["public", "password", "draft"]), password: z.string().optional() }),
    handler: async ({ auth, params, body }) => {
      allProjects(auth);
      await pageOf(params.pageId, auth.organizationId);
      await unwrap(actions.setStatusVisibility(params.pageId, { visibility: body.visibility, password: body.password }));
      return { statusPage: await pageView(params.pageId, auth.organizationId) };
    },
  }),
  route({
    method: "PUT",
    path: "/status-pages/{pageId}/subscriptions",
    tag: "Status pages",
    summary: "Choose how visitors subscribe, and the team channels",
    description:
      "subscribe: which ways the page offers (email, slack, discord, webhook, rss), whether subscribers pick components, and whether outages found by uptime checks are sent. teamChannelIds: the organization's notification channels that get every post.",
    needs: ["status-pages.manage"],
    body: z.object({
      subscribe: z.object({
        email: z.boolean(),
        slack: z.boolean(),
        discord: z.boolean(),
        webhook: z.boolean(),
        rss: z.boolean(),
        components: z.boolean(),
        outages: z.boolean(),
      }),
      teamChannelIds: z.array(z.string()).max(100).default([]),
    }),
    handler: async ({ auth, params, body }) => {
      allProjects(auth);
      await pageOf(params.pageId, auth.organizationId);
      await unwrap(actions.saveStatusSubscriptions(params.pageId, body));
      return { statusPage: await pageView(params.pageId, auth.organizationId) };
    },
  }),
  route({
    method: "POST",
    path: "/status-pages/{pageId}/components",
    tag: "Status pages",
    summary: "Add a component",
    description: "serviceId shows the service's uptime check; without one, only incidents and maintenance change the component. It goes last.",
    needs: ["status-pages.manage"],
    status: 201,
    body: z.object({
      name: z.string(),
      serviceId: z.string().nullable().default(null),
      description: z.string().nullable().default(null),
      group: z.string().nullable().default(null).describe("Section heading it shows under; null for none"),
    }),
    handler: async ({ auth, params, body }) => {
      allProjects(auth);
      await pageOf(params.pageId, auth.organizationId);
      const { id } = await unwrap(actions.addStatusComponent(params.pageId, body));
      return { component: componentView(await componentOf(params.pageId, id)) };
    },
  }),
  route({
    method: "PUT",
    path: "/status-pages/{pageId}/components/order",
    tag: "Status pages",
    summary: "Reorder a page's components",
    description: "ids: every component id of the page, top first.",
    needs: ["status-pages.manage"],
    body: z.object({ ids: z.array(z.string()).max(1000) }),
    handler: async ({ auth, params, body }) => {
      allProjects(auth);
      await pageOf(params.pageId, auth.organizationId);
      await unwrap(actions.reorderStatusComponents(params.pageId, body.ids));
      return { ok: true };
    },
  }),
  route({
    method: "PATCH",
    path: "/status-pages/{pageId}/components/{componentId}",
    tag: "Status pages",
    summary: "Change a component",
    description: "Fields left out keep their value.",
    needs: ["status-pages.manage"],
    body: z.object({
      name: z.string().optional(),
      serviceId: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      group: z.string().nullable().optional(),
    }),
    handler: async ({ auth, params, body }) => {
      allProjects(auth);
      await pageOf(params.pageId, auth.organizationId);
      const c = await componentOf(params.pageId, params.componentId);
      await unwrap(
        actions.updateStatusComponent(c.id, {
          name: body.name ?? c.name,
          serviceId: body.serviceId !== undefined ? body.serviceId : c.serviceId,
          description: body.description !== undefined ? body.description : c.description,
          group: body.group !== undefined ? body.group : c.group,
        }),
      );
      return { component: componentView(await componentOf(params.pageId, c.id)) };
    },
  }),
  route({
    method: "DELETE",
    path: "/status-pages/{pageId}/components/{componentId}",
    tag: "Status pages",
    summary: "Remove a component",
    needs: ["status-pages.manage"],
    handler: async ({ auth, params }) => {
      allProjects(auth);
      await pageOf(params.pageId, auth.organizationId);
      await componentOf(params.pageId, params.componentId);
      await unwrap(actions.removeStatusComponent(params.componentId));
      return { deleted: true };
    },
  }),
  route({
    method: "GET",
    path: "/status-pages/{pageId}/subscribers",
    tag: "Status pages",
    summary: "List subscribers",
    description:
      "Newest first, 25 at a time: pass offset for more while hasMore is true. q searches email addresses; kind keeps one type. Webhook URLs show only where they point, without their secret part.",
    needs: ["status-pages.manage"],
    query: z.object({
      q: z.string().max(200).optional(),
      kind: z.enum(SUBSCRIBER_KINDS).optional(),
      offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
    }),
    handler: async ({ auth, params, query }) => {
      allProjects(auth);
      await pageOf(params.pageId, auth.organizationId);
      const { rows, ...rest } = await unwrap(actions.listStatusSubscribers(params.pageId, query));
      return { subscribers: rows, ...rest };
    },
  }),
  route({
    method: "DELETE",
    path: "/status-pages/{pageId}/subscribers/{subscriberId}",
    tag: "Status pages",
    summary: "Remove a subscriber",
    description: "They hear nothing more from the page.",
    needs: ["status-pages.manage"],
    handler: async ({ auth, params }) => {
      allProjects(auth);
      await pageOf(params.pageId, auth.organizationId);
      const [row] = await db
        .select({ id: schema.statusSubscriber.id })
        .from(schema.statusSubscriber)
        .where(and(eq(schema.statusSubscriber.id, params.subscriberId), eq(schema.statusSubscriber.pageId, params.pageId)));
      if (!row) throw new ApiError(404, "Subscriber not found");
      await unwrap(actions.removeStatusSubscriber(params.subscriberId));
      return { deleted: true };
    },
  }),
];
