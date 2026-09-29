import { type CountedLimit, formatLimitValue, limitCatalog, type OrgLimits, type Usage, usageLevel } from "@/lib/limits";
import { cn } from "@/lib/utils";

/** One row per limit: what is used, the limit, and a bar that turns amber at 80 % and red at 100 %. */
export function UsageBars({ usage, limits, only, compact }: { usage: Usage; limits: OrgLimits; only?: CountedLimit[]; compact?: boolean }) {
  const rows = limitCatalog.filter((l) => (only ? only.includes(l.key) : true));
  return (
    <div className={cn("grid grid-cols-1 gap-x-8", compact ? "gap-y-2.5 sm:grid-cols-2" : "gap-y-4 sm:grid-cols-2")}>
      {rows.map(({ key, label, description }) => {
        const used = usage[key] ?? 0;
        const limit = limits[key];
        const level = usageLevel(used, limit);
        const pct = limit == null ? 0 : limit <= 0 ? 100 : Math.min(100, (used / limit) * 100);
        return (
          <div key={key} className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-[13px] font-medium text-fg" title={description}>
                {label}
              </span>
              <span className={cn("flex-none text-xs tabular-nums", level === "full" ? "text-bad" : level === "warn" ? "text-warn" : "text-muted")}>
                {formatLimitValue(key, used)}
                {limit == null ? <span className="text-faint"> · no limit</span> : ` of ${formatLimitValue(key, limit)}`}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-fg/[0.07]" role="meter" aria-label={label} aria-valuenow={used} aria-valuemax={limit ?? undefined}>
              {limit != null && (
                <div
                  className={cn("h-full rounded-full transition-[width]", level === "full" ? "bg-bad" : level === "warn" ? "bg-warn" : "bg-accent")}
                  style={{ width: `${Math.max(pct, used > 0 ? 2 : 0)}%` }}
                />
              )}
            </div>
            {!compact && <span className="text-[11px] text-faint">{description}</span>}
          </div>
        );
      })}
    </div>
  );
}
