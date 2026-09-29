import { type ChannelScope, type QuietHours, type Severity, severityRank } from "@/lib/notifications";

export type RuleChannel = {
  events: string[];
  scope: ChannelScope | null;
  minSeverity: Severity;
};

export type RuleEvent = {
  event: string;
  severity: Severity;
  ok: boolean;
  projectId: string | null;
  environmentId: string | null;
  serviceId: string | null;
  /** Set on recoveries that close an earlier alert. */
  dedup?: boolean;
};

/** Whether a channel wants this event: its event list, its minimum severity and its scope. */
export function channelWants(channel: RuleChannel, e: RuleEvent) {
  if (!channel.events.includes(e.event)) return false;
  // Recoveries resolve the problem they follow, so they pass whatever the minimum is.
  if (!(e.ok && e.dedup) && severityRank[e.severity] < severityRank[channel.minSeverity]) return false;
  return inScope(channel.scope, e);
}

export function inScope(scope: ChannelScope | null, e: Pick<RuleEvent, "projectId" | "environmentId" | "serviceId">) {
  if (!scope) return true;
  const any = scope.projectIds.length + scope.environmentIds.length + scope.serviceIds.length > 0;
  if (!e.projectId) return scope.includeGlobal;
  if (!any) return true;
  return (
    scope.projectIds.includes(e.projectId) || (!!e.environmentId && scope.environmentIds.includes(e.environmentId)) || (!!e.serviceId && scope.serviceIds.includes(e.serviceId))
  );
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h % 24) * 60 + (m % 60);
};

/** Minutes after midnight in a time zone. Falls back to UTC for unknown zones. */
export function localMinutes(date: Date, timezone: string) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone || "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  }
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/** Inside quiet hours? The window may cross midnight (22:00–07:00). */
export function inQuietHours(q: QuietHours | null, date = new Date()) {
  if (!q?.enabled) return false;
  const start = minutes(q.start);
  const end = minutes(q.end);
  if (start === end) return false;
  const now = localMinutes(date, q.timezone);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export type Decision = "send" | "hold" | "suppress" | "group";

/**
 * What to do with an event that matched: quiet hours hold or drop it (critical may pass),
 * and a repeat of the same event within the throttle window is grouped into the next message.
 */
export function decide(opts: { quietHours: QuietHours | null; severity: Severity; throttleMinutes: number; lastSentAt: Date | null; now?: Date }): Decision {
  const now = opts.now ?? new Date();
  if (inQuietHours(opts.quietHours, now) && !(opts.severity === "critical" && opts.quietHours?.allowCritical)) return opts.quietHours?.digest ? "hold" : "suppress";
  if (opts.throttleMinutes > 0 && opts.lastSentAt && now.getTime() - opts.lastSentAt.getTime() < opts.throttleMinutes * 60_000) return "group";
  return "send";
}

/** Delay before retry `attempt` (1-based) of a failed delivery; null when it should stop. */
export function retryDelay(attempt: number) {
  const steps = [60_000, 5 * 60_000, 30 * 60_000];
  return attempt <= steps.length ? steps[attempt - 1] : null;
}
