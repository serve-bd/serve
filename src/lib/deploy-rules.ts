/**
 * A project's deploy rules: environments whose deploys wait for approval, and times when deploys
 * are frozen. Shared by the server (which enforces them) and the settings page.
 */

/** A weekly time when deploys are frozen, in the rules' time zone. Days: 0 Sunday … 6 Saturday. */
export type FreezeWindow = { days: number[]; start: string; end: string };

export type DeployRules = {
  approval?: {
    enabled: boolean;
    /** The environments whose deploys wait; empty or missing: every environment. */
    environmentIds?: string[];
  } | null;
  freeze?: {
    /** Frozen now, until turned off (or until `until`). */
    now?: { since: string; until?: string | null; reason?: string | null } | null;
    windows?: FreezeWindow[];
    /** IANA time zone the windows are in. */
    timezone?: string;
    environmentIds?: string[];
  } | null;
};

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validTime(t: string) {
  return TIME.test(t);
}

function minutes(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/** The weekday and minute of the day at this moment in a time zone. */
function localTime(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { day: WEEKDAYS.indexOf(get("weekday")), minute: Number(get("hour")) * 60 + Number(get("minute")) };
}

/**
 * Whether a window covers this weekday and minute. A window that ends before it starts runs past
 * midnight: Friday 22:00 to 06:00 covers Saturday's early hours too.
 */
function inWindow(w: FreezeWindow, day: number, minute: number) {
  const start = minutes(w.start);
  const end = minutes(w.end);
  if (start === end) return w.days.includes(day);
  if (start < end) return w.days.includes(day) && minute >= start && minute < end;
  return (w.days.includes(day) && minute >= start) || (w.days.includes((day + 6) % 7) && minute < end);
}

function applies(ids: string[] | undefined, environmentId: string) {
  return !ids?.length || ids.includes(environmentId);
}

export type FreezeState = { frozen: false } | { frozen: true; until: Date | null; reason: string | null; manual: boolean };

/** Whether deploys to an environment are frozen at a moment, and until when. */
export function freezeState(rules: DeployRules | null | undefined, environmentId: string, at = new Date()): FreezeState {
  const freeze = rules?.freeze;
  if (!freeze || !applies(freeze.environmentIds, environmentId)) return { frozen: false };
  const now = freeze.now;
  if (now && (!now.until || new Date(now.until) > at)) return { frozen: true, until: now.until ? new Date(now.until) : null, reason: now.reason ?? null, manual: true };
  const windows = (freeze.windows ?? []).filter((w) => w.days.length && validTime(w.start) && validTime(w.end));
  if (!windows.length) return { frozen: false };
  const tz = freeze.timezone || "UTC";
  const frozenAt = (t: Date) => {
    const { day, minute } = localTime(t, tz);
    return windows.some((w) => inWindow(w, day, minute));
  };
  if (!frozenAt(at)) return { frozen: false };
  // The end: the first minute, looking ahead in 5 minute steps, that no window covers.
  const step = 5 * 60_000;
  let t = new Date(Math.ceil(at.getTime() / step) * step);
  for (let i = 0; i < (8 * 24 * 60) / 5; i++, t = new Date(t.getTime() + step)) if (!frozenAt(t)) return { frozen: true, until: t, reason: null, manual: false };
  return { frozen: true, until: null, reason: null, manual: false };
}

export function needsApproval(rules: DeployRules | null | undefined, environmentId: string) {
  return !!rules?.approval?.enabled && applies(rules.approval.environmentIds, environmentId);
}

/** "until Mon 06:00" or "until it is turned off", for messages. */
export function freezeUntil(state: Extract<FreezeState, { frozen: true }>, timezone = "UTC") {
  if (!state.until) return "until it is turned off";
  const text = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(state.until);
  return `until ${text} (${timezone})`;
}
