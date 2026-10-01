import { cn } from "@/lib/utils";

export type UptimeBar = { day: string; uptime: number | null };

/** Color of a day: green when fully up, amber for partial outages, red for bad days, gray without data. */
function tone(uptime: number | null) {
  if (uptime === null) return "bg-line-strong/60";
  if (uptime >= 99.9) return "bg-ok";
  if (uptime >= 95) return "bg-warn";
  return "bg-bad";
}

// A fixed locale: this renders on the server and in the browser, which may differ.
const formatDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** One thin bar per day, oldest on the left. */
export function UptimeBars({ bars, className, height = 28 }: { bars: UptimeBar[]; className?: string; height?: number }) {
  return (
    <div className={cn("flex w-full items-stretch gap-[2px]", className)} style={{ height }} role="img" aria-label={`Uptime over the last ${bars.length} days`}>
      {bars.map((b) => (
        <span
          key={b.day}
          title={`${formatDay(b.day)}: ${b.uptime === null ? "no data" : `${b.uptime.toFixed(b.uptime >= 99.95 ? 0 : 2)}% up`}`}
          className={cn("min-w-[2px] flex-1 rounded-[2px] transition-opacity hover:opacity-70", tone(b.uptime))}
        />
      ))}
    </div>
  );
}

export function formatUptime(value: number | null) {
  if (value === null) return "—";
  if (value >= 99.995) return "100%";
  return `${value.toFixed(value >= 99 ? 2 : 1)}%`;
}
