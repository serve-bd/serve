/**
 * Which backups to keep. On top of the newest `count`: every backup younger than `days`, and the
 * newest backup of each of the last `daily` days, `weekly` weeks, `monthly` months and `yearly`
 * years (calendar periods in UTC). The newest backup is always kept.
 */
export type KeepRules = { days?: number | null; daily?: number | null; weekly?: number | null; monthly?: number | null; yearly?: number | null };

export const hasKeepRules = (r: KeepRules | null | undefined) => !!r && Object.values(r).some((v) => !!v && v > 0);

const DAY = 86_400_000;

function periodKeys(d: Date) {
  const day = d.toISOString().slice(0, 10);
  // ISO week: the Thursday of the week decides its year.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
  const week = `${t.getUTCFullYear()}-W${Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / DAY + 1) / 7)}`;
  return { daily: day, weekly: week, monthly: day.slice(0, 7), yearly: day.slice(0, 4) };
}

/** `backups` newest first. Returns the ids to keep. */
export function keptBackups(backups: { id: string; createdAt: Date }[], count: number, rules: KeepRules | null | undefined, now = new Date()): Set<string> {
  const keep = new Set(backups.slice(0, Math.max(1, count)).map((b) => b.id));
  if (!rules) return keep;
  if (rules.days) for (const b of backups) if (now.getTime() - b.createdAt.getTime() < rules.days * DAY) keep.add(b.id);
  for (const period of ["daily", "weekly", "monthly", "yearly"] as const) {
    const n = rules[period];
    if (!n) continue;
    const seen = new Set<string>();
    for (const b of backups) {
      const key = periodKeys(b.createdAt)[period];
      if (seen.has(key)) continue;
      if (seen.size >= n) break;
      seen.add(key);
      keep.add(b.id);
    }
  }
  return keep;
}
