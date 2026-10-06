import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import * as actions from "@/server/actions/status-pages";
import { db, schema } from "@/server/db";
import { pageUrl } from "@/server/status-pages/urls";
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

async function noticesOf(pageId: string, filter: { open?: boolean; limit?: number }) {
  const rows = await db
    .select()
    .from(schema.statusNotice)
    .where(eq(schema.statusNotice.pageId, pageId))
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
      return (await noticesOf(params.pageId, { limit: 200 })).find((n) => n.id === id);
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
      return (await noticesOf(params.pageId, { limit: 200 })).find((n) => n.id === params.incidentId);
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
      const current = (await noticesOf(params.pageId, { limit: 200 })).find((n) => n.id === params.incidentId);
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
      return (await noticesOf(params.pageId, { limit: 200 })).find((n) => n.id === params.incidentId);
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
];
