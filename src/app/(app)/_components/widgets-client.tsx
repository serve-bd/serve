"use client";

import { AreaChart } from "@/components/charts/area-chart";
import { useNow } from "@/hooks/use-client";
import { cn } from "@/lib/utils";
import type { DeployBucket } from "@/server/dashboard";

function partOfDay(hour: number) {
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** Hello in the viewer's own time of day, with their clock and date. */
export function Greeting({ name, plain }: { name: string; plain: boolean }) {
  const nowMs = useNow();
  const now = nowMs === null ? null : new Date(nowMs);
  const first = name.trim().split(/\s+/)[0] || "there";
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-2", plain ? "py-1" : "")}>
      <p className="font-display text-[26px] leading-tight font-semibold text-fg">
        {now ? partOfDay(now.getHours()) : "Hello"}, {first}.
      </p>
      <p className="flex items-baseline gap-2 text-muted">
        <span className="font-mono text-[22px] leading-none text-fg-2 tabular-nums">
          {now ? now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "--:--"}
        </span>
        <span className="text-[13px]">{now ? now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) : ""}</span>
      </p>
    </div>
  );
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/**
 * One square per day, a column per week, darker on busier days. Days with a failed deploy get a
 * small red corner, so trouble stands out without coloring the whole calendar.
 */
export function ActivityCalendar({ buckets, weeks }: { buckets: DeployBucket[]; weeks: number }) {
  const nowMs = useNow();
  if (nowMs === null) return <div className="h-[140px]" />;
  const today = new Date(nowMs);
  const counts = new Map<string, { n: number; failed: number }>();
  for (const b of buckets) {
    const k = dayKey(new Date(b.t));
    const c = counts.get(k) ?? { n: 0, failed: 0 };
    c.n += b.n;
    c.failed += b.failed;
    counts.set(k, c);
  }
  // Weeks start on Monday; the last column is this week.
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7) - (weeks - 1) * 7);
  const columns: { date: Date; n: number; failed: number; future: boolean }[][] = [];
  let total = 0;
  let max = 0;
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d);
      const c = counts.get(dayKey(date)) ?? { n: 0, failed: 0 };
      const future = date.getTime() > today.getTime();
      if (!future) {
        total += c.n;
        max = Math.max(max, c.n);
      }
      col.push({ date, ...c, future });
    }
    columns.push(col);
  }
  const level = (n: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / Math.max(max, 1)) * 4)));
  const shade = ["bg-sunken", "bg-fg/15", "bg-fg/30", "bg-fg/50", "bg-fg/75"];
  const months = columns.map((col, i) => {
    const first = col.find((c) => c.date.getDate() <= 7 && c.date.getDay() === 1);
    return first && i > 0 ? first.date.toLocaleDateString(undefined, { month: "short" }) : "";
  });
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto scrollbar-thin">
        {/* Squares grow with the widget, up to a size that still reads as a calendar. */}
        <div className="flex w-full flex-col gap-1" style={{ minWidth: weeks * 9, maxWidth: weeks * 22 }}>
          <div className="grid gap-[3px] text-[10px] text-faint" style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }}>
            {months.map((m, i) => (
              <span key={i} className="overflow-visible whitespace-nowrap">
                {m}
              </span>
            ))}
          </div>
          <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }}>
            {columns.map((col, i) => (
              <div key={i} className="flex flex-col gap-[3px]">
                {col.map((c) => (
                  <span
                    key={c.date.getTime()}
                    title={
                      c.future
                        ? undefined
                        : `${c.n} ${c.n === 1 ? "deploy" : "deploys"}${c.failed ? `, ${c.failed} failed` : ""} on ${c.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`
                    }
                    className={cn("relative aspect-square w-full overflow-hidden rounded-[3px]", c.future ? "bg-transparent" : shade[level(c.n)])}
                  >
                    {c.failed > 0 && <span className="absolute top-0 right-0 size-[40%] rounded-bl-[2px] bg-bad" />}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>
          {total} {total === 1 ? "deploy" : "deploys"} in the last {weeks} weeks
        </span>
        <span className="flex items-center gap-1 text-faint">
          Less
          {shade.map((s) => (
            <span key={s} className={cn("size-[10px] rounded-[3px]", s)} />
          ))}
          More
        </span>
      </div>
    </div>
  );
}

type Sample = { t: number; cpu: number; memory: number; memoryLimit: number };

/** CPU and memory of one server, last 6 hours. */
export function ServerUsage({ series }: { series: Sample[] }) {
  const last = series.at(-1);
  const mem = (s: Sample) => (s.memoryLimit ? (s.memory / s.memoryLimit) * 100 : null);
  const rows = [
    { label: "CPU", data: series.map((s) => ({ t: s.t, v: s.cpu })), now: last?.cpu ?? null },
    { label: "Memory", data: series.map((s) => ({ t: s.t, v: mem(s) })), now: last ? mem(last) : null },
  ];
  return (
    <div className="flex flex-col gap-4">
      {rows.map((r) => (
        <div key={r.label} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-faint">{r.label}</span>
            <span className={cn("font-mono tabular-nums", r.now !== null && r.now > 90 ? "text-bad" : "text-fg-2")}>{r.now === null ? "–" : `${Math.round(r.now)}%`}</span>
          </div>
          <AreaChart data={r.data} height={56} max={100} color="var(--fg-2)" format={(v) => `${v.toFixed(0)}%`} />
        </div>
      ))}
    </div>
  );
}
