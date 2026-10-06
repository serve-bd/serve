/**
 * Public status pages: the look a page can take, the status levels it shows and the pure rules
 * that turn checks and notices into those levels. No database here, so the editor's preview and
 * the tests use the same rules as the public page.
 */

export type StatusLevel = "operational" | "maintenance" | "degraded" | "partial" | "major" | "unknown";

/** Worse levels win. Unknown (no checks yet) never hides a real state. */
const RANK: Record<StatusLevel, number> = { unknown: -1, operational: 0, maintenance: 1, degraded: 2, partial: 3, major: 4 };

export const LEVEL_TEXT: Record<StatusLevel, string> = {
  operational: "Operational",
  maintenance: "Under maintenance",
  degraded: "Degraded performance",
  partial: "Partial outage",
  major: "Major outage",
  unknown: "No data yet",
};

/** The banner over the page. */
export const OVERALL_TEXT: Record<StatusLevel, string> = {
  operational: "All systems operational",
  maintenance: "Maintenance in progress",
  degraded: "Some systems are slow",
  partial: "Some systems are down",
  major: "Major outage",
  unknown: "Waiting for the first checks",
};

export function worst(levels: StatusLevel[]): StatusLevel {
  let out: StatusLevel = "unknown";
  for (const l of levels) if (RANK[l] > RANK[out]) out = l;
  return out;
}

export type IncidentImpact = "minor" | "major" | "critical";
export type IncidentState = "investigating" | "identified" | "monitoring" | "resolved";
export type NoticeKind = "incident" | "maintenance";

export const INCIDENT_STATES: IncidentState[] = ["investigating", "identified", "monitoring", "resolved"];
export const STATE_TEXT: Record<IncidentState | "scheduled" | "in-progress" | "completed", string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
  scheduled: "Scheduled",
  "in-progress": "In progress",
  completed: "Completed",
};
export const IMPACT_TEXT: Record<IncidentImpact, string> = { minor: "Slow or partly broken", major: "Partly down", critical: "Fully down" };
export const IMPACT_LEVEL: Record<IncidentImpact, StatusLevel> = { minor: "degraded", major: "partial", critical: "major" };

export type MaintenancePhase = "scheduled" | "in-progress" | "completed";

/** Where a maintenance window is now: by its times, unless it was completed early. */
export function maintenancePhase(n: { startsAt: string | null; endsAt: string | null; resolvedAt: string | null }, now = Date.now()): MaintenancePhase {
  if (n.resolvedAt) return "completed";
  if (n.startsAt && Date.parse(n.startsAt) > now) return "scheduled";
  if (n.endsAt && Date.parse(n.endsAt) <= now) return "completed";
  return "in-progress";
}

/** A notice as the page's rules see it. */
export type NoticeFacts = {
  kind: NoticeKind;
  impact: IncidentImpact;
  componentIds: string[];
  startsAt: string | null;
  endsAt: string | null;
  resolvedAt: string | null;
};

export function noticeActive(n: NoticeFacts, now = Date.now()) {
  return n.kind === "maintenance" ? maintenancePhase(n, now) === "in-progress" : !n.resolvedAt;
}

/**
 * The level of one component now. Maintenance wins over a failing check: the owner said it would
 * be down. A posted incident sets at least its impact; a failing check means a major outage.
 */
export function componentLevel(input: { componentId: string; check: "up" | "down" | "pending" | "paused" | null; notices: NoticeFacts[]; now?: number }): StatusLevel {
  const active = input.notices.filter((n) => n.componentIds.includes(input.componentId) && noticeActive(n, input.now));
  if (active.some((n) => n.kind === "maintenance")) return "maintenance";
  const fromNotices = active.filter((n) => n.kind === "incident").map((n) => IMPACT_LEVEL[n.impact]);
  const fromCheck: StatusLevel = input.check === "down" ? "major" : input.check === "up" ? "operational" : "unknown";
  const level = worst([fromCheck, ...fromNotices]);
  // A component without a check and nothing posted is fine as far as anyone said.
  return level === "unknown" && input.check === null ? "operational" : level;
}

/** Bar color of one day: the monitor's uptime, made worse by incidents posted for that day. */
export function dayLevel(uptime: number | null, posted: IncidentImpact[]): StatusLevel {
  const fromUptime: StatusLevel = uptime === null ? "unknown" : uptime >= 99.9 ? "operational" : uptime >= 95 ? "degraded" : "major";
  return worst([fromUptime, ...posted.map((i) => IMPACT_LEVEL[i])]);
}

/* -------------------------------------------------------------------------- */
/*                                    Look                                    */
/* -------------------------------------------------------------------------- */

export type StatusTheme = "auto" | "light" | "dark";
export type StatusFont = "sans" | "serif" | "mono";
export type StatusCorners = "round" | "square";
export type StatusDensity = "comfortable" | "compact";
export const BAR_DAYS = [30, 60, 90] as const;

export type StatusImage = { hash: string; mime: string };

/** A saved incident message: filled into the form in one click. */
export type StatusTemplate = { id: string; name: string; title: string; impact: IncidentImpact; body: string };

/**
 * Every fixed text on the public page, with its default. A page can reword or translate any of them;
 * {days} and {name} are filled in.
 */
export const DEFAULT_LABELS = {
  "overall.operational": OVERALL_TEXT.operational,
  "overall.maintenance": OVERALL_TEXT.maintenance,
  "overall.degraded": OVERALL_TEXT.degraded,
  "overall.partial": OVERALL_TEXT.partial,
  "overall.major": OVERALL_TEXT.major,
  "overall.unknown": OVERALL_TEXT.unknown,
  "level.operational": LEVEL_TEXT.operational,
  "level.maintenance": LEVEL_TEXT.maintenance,
  "level.degraded": LEVEL_TEXT.degraded,
  "level.partial": LEVEL_TEXT.partial,
  "level.major": LEVEL_TEXT.major,
  "level.unknown": LEVEL_TEXT.unknown,
  "state.investigating": STATE_TEXT.investigating,
  "state.identified": STATE_TEXT.identified,
  "state.monitoring": STATE_TEXT.monitoring,
  "state.resolved": STATE_TEXT.resolved,
  "state.scheduled": STATE_TEXT.scheduled,
  "state.in-progress": STATE_TEXT["in-progress"],
  "state.completed": STATE_TEXT.completed,
  updated: "Updated",
  planned: "Planned maintenance",
  past: "Past incidents",
  noIncidents: "No incidents in the last {days} days.",
  daysAgo: "{days} days ago",
  today: "Today",
  uptime: "uptime",
  responseTime: "Response time",
  started: "Started",
  lasted: "lasted",
  noData: "No data",
  postmortem: "Postmortem",
  outageOne: "{name} is unavailable",
  outageOnePast: "{name} was unavailable",
  poweredBy: "Powered by",
  subscribe: "RSS",
  "sub.button": "Subscribe",
  "sub.title": "Get updates",
  "sub.intro": "Hear about incidents and maintenance as they happen.",
  "sub.email": "Email",
  "sub.slack": "Slack",
  "sub.discord": "Discord",
  "sub.webhook": "Webhook",
  "sub.rss": "RSS",
  "sub.components": "Only these components",
  "sub.submit": "Subscribe",
  "sub.checkEmail": "Check your inbox: we sent a link to confirm.",
  "sub.done": "You are subscribed.",
} as const;

export type LabelKey = keyof typeof DEFAULT_LABELS;
export type Labels = Record<LabelKey, string>;

export function labelsOf(design: Pick<StatusDesign, "labels">): Labels {
  const out = { ...DEFAULT_LABELS } as Labels;
  for (const [k, v] of Object.entries(design.labels ?? {})) if (k in out && typeof v === "string" && v.trim()) out[k as LabelKey] = v.trim();
  return out;
}

/** A label with its {placeholders} filled in. */
export function fill(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}

export type StatusDesign = {
  theme: StatusTheme;
  /** Hex color of links, buttons and the operational banner; null keeps the default green. */
  accent: string | null;
  /** Text under the page name. */
  description: string | null;
  logo: StatusImage | null;
  logoDark: StatusImage | null;
  /** Where the logo links to, like the company's website. */
  website: string | null;
  /** Show the page name next to the logo. */
  showName: boolean;
  days: (typeof BAR_DAYS)[number];
  showBars: boolean;
  showUptime: boolean;
  /** Average response time over the last day, per component. */
  showLatency: boolean;
  /** Days of past incidents to list; 0 hides the history. */
  historyDays: number;
  /** Outages found by uptime checks show up as incidents on their own. */
  autoIncidents: boolean;
  announcement: { text: string; tone: "info" | "warn" } | null;
  links: { label: string; url: string }[];
  footer: string | null;
  hideBadge: boolean;
  font: StatusFont;
  corners: StatusCorners;
  density: StatusDensity;
  /** Extra CSS for the page only. */
  css: string | null;
  /** Ask search engines not to list the page. */
  noindex: boolean;
  /** Reworded or translated texts (DEFAULT_LABELS); missing keys keep the default. */
  labels: Partial<Record<LabelKey, string>>;
  /** Language of dates and of the page, like "de" or "fr-CA"; null follows the visitor's browser. */
  locale: string | null;
};

export const defaultDesign: StatusDesign = {
  theme: "auto",
  accent: null,
  description: null,
  logo: null,
  logoDark: null,
  website: null,
  showName: true,
  days: 90,
  showBars: true,
  showUptime: true,
  showLatency: false,
  historyDays: 14,
  autoIncidents: true,
  announcement: null,
  links: [],
  footer: null,
  hideBadge: false,
  font: "sans",
  corners: "round",
  density: "comfortable",
  css: null,
  noindex: false,
  labels: {},
  locale: null,
};

export function designOf(saved: Partial<StatusDesign> | null | undefined): StatusDesign {
  return { ...defaultDesign, ...(saved ?? {}) };
}

export type StatusVisibility = "public" | "password" | "draft";

/* -------------------------------------------------------------------------- */
/*                                Subscriptions                               */
/* -------------------------------------------------------------------------- */

export const SUBSCRIBER_KINDS = ["email", "slack", "discord", "webhook"] as const;
export type SubscriberKind = (typeof SUBSCRIBER_KINDS)[number];

/** Which ways to subscribe a page offers, and what subscribers hear about. */
export type SubscribeConfig = {
  email: boolean;
  slack: boolean;
  discord: boolean;
  webhook: boolean;
  rss: boolean;
  /** Subscribers may pick the components they care about. */
  components: boolean;
  /** Outages found by uptime checks are sent too (the page must show them). */
  outages: boolean;
};

export const defaultSubscribe: SubscribeConfig = { email: false, slack: false, discord: false, webhook: false, rss: true, components: true, outages: false };

export function subscribeOf(saved: Partial<SubscribeConfig> | null | undefined): SubscribeConfig {
  return { ...defaultSubscribe, ...(saved ?? {}) };
}

/** Where a chat webhook must point: a visitor's URL never reaches anything else. */
export function chatWebhookProblem(kind: "slack" | "discord", raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "That is not a valid URL.";
  }
  if (url.protocol !== "https:" || url.username || url.password) return "Use the https:// webhook URL.";
  if (kind === "slack")
    return url.hostname === "hooks.slack.com" && url.pathname.startsWith("/services/") ? null : "A Slack webhook URL starts with https://hooks.slack.com/services/.";
  const host = url.hostname.replace(/^(ptb|canary)\./, "");
  return (host === "discord.com" || host === "discordapp.com") && url.pathname.startsWith("/api/webhooks/")
    ? null
    : "A Discord webhook URL starts with https://discord.com/api/webhooks/.";
}

/** How a subscriber's address shows in the dashboard: webhook URLs carry secrets, so only their host. */
export function maskTarget(kind: SubscriberKind, target: string) {
  if (kind === "email") return target;
  try {
    const u = new URL(target);
    return `${u.host}/…`;
  } catch {
    return "…";
  }
}

export const RESERVED_SLUGS = ["new", "api", "admin", "login", "status"];

/** A slug from a name: "Acme Cloud" → "acme-cloud". */
export function slugify(name: string) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/** Custom CSS goes inside a <style> element: it must not be able to close it. */
export function cleanCss(css: string | null | undefined) {
  const out = (css ?? "").replace(/<\/?\s*style/gi, "").trim();
  return out || null;
}

/** Only web links: no javascript: or data: URLs on a public page. */
export function cleanUrl(url: string | null | undefined): string | null {
  const v = (url ?? "").trim();
  if (!v) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);
    if (u.protocol !== "https:" && u.protocol !== "http:" && u.protocol !== "mailto:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function formatPercent(value: number | null) {
  if (value === null) return "—";
  if (value >= 99.995) return "100%";
  return `${value.toFixed(value >= 99 ? 2 : 1)}%`;
}
