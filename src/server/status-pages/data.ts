import { and, asc, avg, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { dailyBars, uptimePercent } from "@/server/monitoring/state";
import {
  componentLevel,
  dayLevel,
  designOf,
  IMPACT_LEVEL,
  type IncidentImpact,
  maintenancePhase,
  type NoticeFacts,
  noticeActive,
  STATE_TEXT,
  type StatusDesign,
  type StatusLevel,
  worst,
} from "@/lib/status-page";

/** Columns of a page without its images (they can be large). */
export const pageColumns = {
  id: schema.statusPage.id,
  organizationId: schema.statusPage.organizationId,
  name: schema.statusPage.name,
  slug: schema.statusPage.slug,
  domain: schema.statusPage.domain,
  https: schema.statusPage.https,
  certificateId: schema.statusPage.certificateId,
  tunnelId: schema.statusPage.tunnelId,
  visibility: schema.statusPage.visibility,
  passwordHash: schema.statusPage.passwordHash,
  design: schema.statusPage.design,
  updatedAt: schema.statusPage.updatedAt,
};

export type PageRow = { [K in keyof typeof pageColumns]: (typeof pageColumns)[K]["_"]["data"] } & { passwordHash: string | null };

export async function pageBySlug(slug: string): Promise<PageRow | null> {
  const [row] = await db.select(pageColumns).from(schema.statusPage).where(eq(schema.statusPage.slug, slug.toLowerCase()));
  return (row as PageRow | undefined) ?? null;
}

export type NoticeView = {
  id: string;
  /** "outage" is one an uptime check found on its own. */
  kind: "incident" | "maintenance" | "outage";
  title: string;
  impact: IncidentImpact;
  /** Shown next to the title: Investigating, Scheduled, Resolved… */
  state: string;
  done: boolean;
  components: string[];
  startsAt: string | null;
  endsAt: string | null;
  resolvedAt: string | null;
  updates: { state: string; body: string; at: string }[];
};

export type DayView = { day: string; level: StatusLevel; uptime: number | null; notes: string[] };

export type ComponentView = {
  id: string;
  name: string;
  description: string | null;
  level: StatusLevel;
  /** Over the days the bars cover. */
  uptime: number | null;
  /** Average response time over the last day, in ms. */
  latency: number | null;
  monitored: boolean;
  bars: DayView[];
};

export type StatusView = {
  name: string;
  slug: string;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  /** The tab icon: the page's favicon, else its logo, else the instance's branding (iconOf). */
  iconUrl: string;
  overall: StatusLevel;
  groups: { name: string | null; components: ComponentView[] }[];
  active: NoticeView[];
  upcoming: NoticeView[];
  history: { day: string; notices: NoticeView[] }[];
  generatedAt: string;
};

const iso = (d: Date | null) => d?.toISOString() ?? null;
const DAY = 86400_000;

/**
 * Everything the public page shows, and nothing more: component names chosen by the owner, never
 * service names, URLs or check errors. `base` is the path the page's own links start with.
 */
export async function statusView(
  page: Pick<PageRow, "id" | "name" | "slug" | "design" | "updatedAt">,
  base: string,
  design: StatusDesign = designOf(page.design),
): Promise<StatusView> {
  const now = Date.now();
  const components = await db.select().from(schema.statusComponent).where(eq(schema.statusComponent.pageId, page.id)).orderBy(asc(schema.statusComponent.position));
  const serviceIds = components.map((c) => c.serviceId).filter((s): s is string => !!s);
  const monitors = serviceIds.length ? await db.select().from(schema.monitor).where(inArray(schema.monitor.serviceId, serviceIds)) : [];
  const monitorOf = new Map(monitors.map((m) => [m.serviceId, m]));
  const monitorIds = monitors.map((m) => m.id);
  const since = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() - (design.days - 1)));
  const historyStart = new Date(now - Math.max(design.historyDays, 1) * DAY);

  const [daily, latency, notices, outages] = await Promise.all([
    monitorIds.length
      ? db
          .select()
          .from(schema.monitorDaily)
          .where(and(inArray(schema.monitorDaily.monitorId, monitorIds), gte(schema.monitorDaily.day, since.toISOString().slice(0, 10))))
      : [],
    monitorIds.length && design.showLatency
      ? db
          .select({ monitorId: schema.monitorCheck.monitorId, ms: avg(schema.monitorCheck.latencyMs) })
          .from(schema.monitorCheck)
          .where(and(inArray(schema.monitorCheck.monitorId, monitorIds), gte(schema.monitorCheck.createdAt, new Date(now - DAY)), eq(schema.monitorCheck.ok, true)))
          .groupBy(schema.monitorCheck.monitorId)
      : [],
    db
      .select()
      .from(schema.statusNotice)
      .where(
        and(
          eq(schema.statusNotice.pageId, page.id),
          // Open ones, anything newer than the bars or the history, and maintenance still ahead.
          or(
            isNull(schema.statusNotice.resolvedAt),
            gte(schema.statusNotice.createdAt, since < historyStart ? since : historyStart),
            gte(schema.statusNotice.endsAt, new Date(now)),
          ),
        ),
      )
      .orderBy(desc(schema.statusNotice.createdAt)),
    design.autoIncidents && serviceIds.length
      ? db
          .select()
          .from(schema.incident)
          .where(
            and(
              inArray(schema.incident.serviceId, serviceIds),
              eq(schema.incident.kind, "down"),
              or(isNull(schema.incident.resolvedAt), gte(schema.incident.startedAt, since < historyStart ? since : historyStart)),
            ),
          )
          .orderBy(desc(schema.incident.startedAt))
      : [],
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

  const nameOf = new Map(components.map((c) => [c.id, c.name]));
  const facts: (NoticeFacts & { id: string })[] = notices.map((n) => ({
    id: n.id,
    kind: n.kind,
    impact: n.impact,
    componentIds: n.componentIds,
    startsAt: iso(n.startsAt ?? n.createdAt),
    endsAt: iso(n.endsAt),
    resolvedAt: iso(n.resolvedAt),
  }));

  const noticeViews: NoticeView[] = notices.map((n, i) => {
    const f = facts[i];
    const phase = n.kind === "maintenance" ? maintenancePhase(f, now) : null;
    return {
      id: n.id,
      kind: n.kind,
      title: n.title,
      impact: n.impact,
      state: phase ? STATE_TEXT[phase] : STATE_TEXT[n.state],
      done: phase ? phase === "completed" : !!n.resolvedAt,
      components: n.componentIds.map((id) => nameOf.get(id)).filter((x): x is string => !!x),
      startsAt: f.startsAt,
      endsAt: f.endsAt,
      resolvedAt: f.resolvedAt ?? (phase === "completed" ? f.endsAt : null),
      updates: updates
        .filter((u) => u.noticeId === n.id)
        .map((u) => ({ state: STATE_TEXT[u.state as keyof typeof STATE_TEXT] ?? u.state, body: u.body, at: u.createdAt.toISOString() })),
    };
  });

  // An outage inside a maintenance window of the same component was planned: it is not news.
  const componentsOfService = (serviceId: string | null) => components.filter((c) => c.serviceId && c.serviceId === serviceId);
  const planned = (componentIds: string[], at: number) =>
    facts.some(
      (f) => f.kind === "maintenance" && f.componentIds.some((id) => componentIds.includes(id)) && Date.parse(f.startsAt ?? "") <= at && (!f.endsAt || Date.parse(f.endsAt) >= at),
    );
  const outageViews: NoticeView[] = [];
  for (const o of outages) {
    const comps = componentsOfService(o.serviceId);
    if (
      !comps.length ||
      planned(
        comps.map((c) => c.id),
        o.startedAt.getTime(),
      )
    )
      continue;
    const names = comps.map((c) => c.name);
    outageViews.push({
      id: `outage-${o.id}`,
      kind: "outage",
      title: o.resolvedAt ? `${names.join(", ")} ${names.length === 1 ? "was" : "were"} unavailable` : `${names.join(", ")} ${names.length === 1 ? "is" : "are"} unavailable`,
      impact: "critical",
      state: o.resolvedAt ? "Resolved" : "Investigating",
      done: !!o.resolvedAt,
      components: names,
      startsAt: o.startedAt.toISOString(),
      endsAt: null,
      resolvedAt: iso(o.resolvedAt),
      updates: [],
    });
  }

  const latencyOf = new Map(latency.map((l) => [l.monitorId, l.ms === null ? null : Math.round(Number(l.ms))]));
  const views: (ComponentView & { group: string | null })[] = components.map((c) => {
    const m = c.serviceId ? monitorOf.get(c.serviceId) : undefined;
    const check = m ? (m.enabled ? m.status : "paused") : null;
    const rows = m ? daily.filter((d) => d.monitorId === m.id) : [];
    const bars = dailyBars(rows, design.days, new Date(now)).map((b) => {
      const dayStart = Date.parse(`${b.day}T00:00:00Z`);
      const dayEnd = dayStart + DAY;
      const touching = [...noticeViews.filter((n) => n.kind === "incident"), ...outageViews].filter((n) => {
        const own = n.kind === "outage" ? n.components.includes(c.name) : notices.find((x) => x.id === n.id)?.componentIds.includes(c.id);
        if (!own) return false;
        const start = Date.parse(n.startsAt ?? "");
        const end = n.resolvedAt ? Date.parse(n.resolvedAt) : now;
        return start < dayEnd && end >= dayStart;
      });
      // A day with a posted incident is at least as bad as it said, even without a check.
      const posted = touching.filter((n) => n.kind === "incident").map((n) => n.impact);
      // Without a check: fine since it was added, unless an incident said otherwise.
      const level = m ? dayLevel(b.uptime, posted) : dayEnd <= c.createdAt.getTime() ? "unknown" : worst(["operational", ...posted.map((p) => IMPACT_LEVEL[p])]);
      return { day: b.day, level, uptime: m ? b.uptime : null, notes: touching.map((n) => n.title) };
    });
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      group: c.group,
      level: componentLevel({ componentId: c.id, check, notices: facts, now }),
      uptime: m ? uptimePercent(rows) : null,
      latency: m ? (latencyOf.get(m.id) ?? null) : null,
      monitored: !!m,
      bars,
    };
  });

  // Groups keep the order of their first component.
  const groups: StatusView["groups"] = [];
  for (const v of views) {
    const { group, ...component } = v;
    const last = groups.at(-1);
    const existing = group ? groups.find((g) => g.name === group) : last && last.name === null ? last : undefined;
    if (existing) existing.components.push(component);
    else groups.push({ name: group, components: [component] });
  }

  const all = [...noticeViews, ...outageViews];
  const active = all.filter((n) => (n.kind === "maintenance" ? n.state === STATE_TEXT["in-progress"] : !n.done));
  const upcoming = noticeViews
    .filter((n) => n.kind === "maintenance" && n.state === STATE_TEXT.scheduled)
    .sort((a, b) => Date.parse(a.startsAt ?? "") - Date.parse(b.startsAt ?? ""));
  const past = all.filter((n) => n.done && Date.parse(n.resolvedAt ?? n.startsAt ?? "") >= historyStart.getTime());
  const byDay = new Map<string, NoticeView[]>();
  for (const n of past.sort((a, b) => Date.parse(b.startsAt ?? "") - Date.parse(a.startsAt ?? ""))) {
    const day = (n.startsAt ?? "").slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), n]);
  }

  const images = await db.select({ images: schema.statusPage.images }).from(schema.statusPage).where(eq(schema.statusPage.id, page.id));
  const img = images[0]?.images ?? {};
  return {
    name: page.name,
    slug: page.slug,
    logoUrl: img.logo ? `${base}/logo?v=${img.logo.hash}` : null,
    logoDarkUrl: img.logoDark ? `${base}/logo?dark=1&v=${img.logoDark.hash}` : null,
    iconUrl: await pageIconUrl(page.id, base, img),
    overall: views.length ? worst([...views.map((v) => v.level), ...(active.some((n) => n.kind === "maintenance") ? (["maintenance"] as const) : [])]) : "unknown",
    groups,
    active,
    upcoming,
    history: design.historyDays > 0 ? [...byDay].map(([day, list]) => ({ day, notices: list })) : [],
    generatedAt: new Date(now).toISOString(),
  };
}

export { noticeActive };

/** The page's tab icon route, versioned by the image it serves so a new upload shows at once. */
export async function pageIconUrl(pageId: string, base: string, images?: { favicon?: { hash: string }; logo?: { hash: string } }) {
  const img = images ?? (await db.select({ images: schema.statusPage.images }).from(schema.statusPage).where(eq(schema.statusPage.id, pageId)))[0]?.images ?? {};
  return `${base}/icon?v=${(img.favicon ?? img.logo)?.hash ?? (await brandIconHash()) ?? "default"}`;
}

/** Hash of the instance's branding icon (its favicon, else its logo), if one was uploaded. */
async function brandIconHash() {
  const [row] = await db.select({ value: schema.setting.value }).from(schema.setting).where(eq(schema.setting.key, "branding"));
  const b = row?.value as { favicon?: { hash: string } | null; logo?: { hash: string } | null } | undefined;
  return (b?.favicon ?? b?.logo)?.hash ?? null;
}
