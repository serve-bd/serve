/**
 * Pure monitoring logic (no database, no network): status transitions, accepted status
 * codes, uptime rollups and alert hysteresis. Kept separate so it is easy to test.
 */

export type MonitorState = { status: "pending" | "up" | "down" | "paused"; consecutiveFailures: number };
export type Transition = "down" | "recovered" | null;

/**
 * Next state after one check. A service goes down only after `threshold` failures in a
 * row (so one slow request does not page anyone) and recovers on the first success.
 */
export function nextMonitorState(prev: MonitorState, ok: boolean, threshold: number): MonitorState & { transition: Transition } {
  const limit = Math.max(1, threshold);
  if (ok) {
    return { status: "up", consecutiveFailures: 0, transition: prev.status === "down" ? "recovered" : null };
  }
  const failures = prev.consecutiveFailures + 1;
  if (failures >= limit) return { status: "down", consecutiveFailures: failures, transition: prev.status === "down" ? null : "down" };
  // Not enough failures yet: keep the last known status (pending stays pending).
  return { status: prev.status === "paused" ? "pending" : prev.status, consecutiveFailures: failures, transition: null };
}

/**
 * Accepted status codes from a spec like "200-399", "200,204" or "2xx,301".
 * Returns null when the spec is invalid.
 */
export function parseExpectedStatus(spec: string): ((code: number) => boolean) | null {
  const parts = spec
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return null;
  const tests: ((c: number) => boolean)[] = [];
  for (const part of parts) {
    let m = /^([1-5])xx$/.exec(part);
    if (m) {
      const base = Number(m[1]) * 100;
      tests.push((c) => c >= base && c < base + 100);
      continue;
    }
    m = /^(\d{3})-(\d{3})$/.exec(part);
    if (m) {
      const [lo, hi] = [Number(m[1]), Number(m[2])];
      if (lo > hi) return null;
      tests.push((c) => c >= lo && c <= hi);
      continue;
    }
    m = /^(\d{3})$/.exec(part);
    if (m) {
      const code = Number(m[1]);
      tests.push((c) => c === code);
      continue;
    }
    return null;
  }
  return (code) => tests.some((t) => t(code));
}

/** UTC day key (YYYY-MM-DD) of a date. */
export function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

export type DailyRow = { day: string; checks: number; failures: number; latencySum?: number; latencyCount?: number };
export type DayBar = { day: string; uptime: number | null; checks: number; failures: number };

/** One bar per day for the last `days` days (oldest first); days without checks have uptime null. */
export function dailyBars(rows: DailyRow[], days: number, today: Date = new Date()): DayBar[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const bars: DayBar[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = dayKey(d);
    const row = byDay.get(key);
    bars.push({
      day: key,
      checks: row?.checks ?? 0,
      failures: row?.failures ?? 0,
      uptime: row?.checks ? ((row.checks - row.failures) / row.checks) * 100 : null,
    });
  }
  return bars;
}

/** Uptime percent over rows, or null without any check. */
export function uptimePercent(rows: Pick<DailyRow, "checks" | "failures">[]): number | null {
  const checks = rows.reduce((a, r) => a + r.checks, 0);
  if (!checks) return null;
  const failures = rows.reduce((a, r) => a + r.failures, 0);
  return ((checks - failures) / checks) * 100;
}

/**
 * Whether an alert is active, with hysteresis: it starts at the threshold and only clears
 * once the value is `margin` points below it, so a value hovering at the line does not flap.
 */
export function alertActive(value: number, threshold: number, wasActive: boolean, margin = 5): boolean {
  if (wasActive) return value >= threshold - margin;
  return value >= threshold;
}

export type RestartSample = { at: number; restartCount: number };

/**
 * A container is crash looping when Docker restarted it at least `minRestarts` times within
 * `windowMs`. Samples are the restart counts seen over time (oldest first).
 */
export function isCrashLooping(samples: RestartSample[], now: number, windowMs = 10 * 60_000, minRestarts = 3): boolean {
  const recent = samples.filter((s) => now - s.at <= windowMs);
  if (recent.length < 2) return false;
  const first = recent[0].restartCount;
  const last = recent[recent.length - 1].restartCount;
  return last - first >= minRestarts;
}
