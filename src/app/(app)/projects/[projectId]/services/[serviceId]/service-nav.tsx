"use client";

import Link from "next/link";
import { AlertTriangle, ChevronLeft } from "lucide-react";
import { SectionPicker } from "@/components/shell/section-picker";
import { cn } from "@/lib/utils";

export type ServiceNavItem = {
  href: string;
  /** Where it links when that differs from `href` (Settings opens its first section). */
  to?: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  group: "Monitor" | "Work with it" | "Configure";
  count?: number;
  issue?: "bad" | "warn" | null;
  active: boolean;
  /** Its own pages (Settings' sections, Backups' pages): listed under it while it is open. */
  sub?: SubPage[];
};

/** `group`: a heading in the drill-down list (Settings); sub-pages without groups nest under their page (Backups). */
export type SubPage = { href: string; label: string; active: boolean; danger?: boolean; group?: string };

const subLinkClass = (s: SubPage) =>
  cn(
    "rounded-lg px-2.5 py-1.5 text-[13px] transition-colors",
    s.active ? "bg-fg/[0.06] font-medium text-fg" : "text-fg-2/80 hover:bg-fg/[0.04] hover:text-fg",
    s.danger && (s.active ? "text-bad" : "text-bad/80 hover:text-bad"),
  );

/** Settings' sections take the whole menu, under their headings, with the way back on top. */
type Back = { href: string };

function DrillDown({ item, back }: { item: ServiceNavItem; back: Back }) {
  const sub = item.sub ?? [];
  const groups = [...new Set(sub.map((s) => s.group ?? ""))];
  return (
    <>
      <Link
        href={back.href}
        className="group mb-4 flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-fg-2/80 transition-colors hover:bg-fg/[0.04] hover:text-fg"
      >
        <span className="grid size-6 flex-none place-items-center rounded-md border border-line bg-surface transition-colors group-hover:border-line-strong">
          <ChevronLeft className="size-3.5 transition-transform group-hover:-translate-x-px" />
        </span>
        All pages
      </Link>
      <p className="flex items-center gap-2 px-2.5 pb-3 text-[15px] font-semibold text-fg">
        <item.icon className="size-[18px] text-muted" /> {item.label}
      </p>
      {groups.map((g) => (
        <div key={g || "rest"} className="flex flex-col gap-0.5 pb-3">
          {g && <p className="px-2.5 pt-1 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">{g}</p>}
          {sub
            .filter((s) => (s.group ?? "") === g)
            .map((s) => (
              <Link key={s.href} href={s.href} prefetch aria-current={s.active ? "page" : undefined} className={subLinkClass(s)}>
                {s.label}
              </Link>
            ))}
        </div>
      ))}
    </>
  );
}

const GROUPS = ["Monitor", "Work with it", "Configure"] as const;

/**
 * The service's pages beside its content on wide screens, in three groups. Settings' sections
 * replace the menu while it is open (with the way back on top); Backups' few pages nest under it.
 */
export function ServiceSidebar({ items, back }: { items: ServiceNavItem[]; back: Back }) {
  const drilled = items.find((i) => i.active && i.sub?.some((s) => s.group));
  return (
    <nav aria-label="Service" className="sticky top-6 hidden max-h-[calc(100dvh-3rem)] w-52 flex-none flex-col self-start overflow-y-auto pt-6 pr-2 pb-8 lg:flex">
      {drilled ? (
        <DrillDown item={drilled} back={back} />
      ) : (
        GROUPS.map((group) => {
          const list = items.filter((i) => i.group === group);
          if (!list.length) return null;
          return (
            <div key={group} className="flex flex-col gap-0.5 pb-4">
              <p className="px-2.5 pb-1.5 text-[11px] font-medium tracking-wide text-faint uppercase">{group}</p>
              {list.map((item) => (
                <div key={item.href}>
                  <Link
                    href={item.to ?? item.href}
                    prefetch
                    aria-current={item.active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors",
                      item.active ? "bg-fg/[0.06] text-fg" : "text-fg-2/80 hover:bg-fg/[0.04] hover:text-fg",
                    )}
                  >
                    <item.icon className={cn("size-4 flex-none", item.active ? "text-fg" : "text-muted")} />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {!!item.count && (
                      <span className="min-w-[18px] rounded-full bg-fg/[0.08] px-1.5 py-px text-center text-[11px] leading-4 font-semibold text-fg-2 tabular-nums">
                        {item.count}
                      </span>
                    )}
                    {item.issue && <AlertTriangle className={cn("size-3.5 flex-none", item.issue === "bad" ? "text-bad" : "text-warn")} aria-label="Needs attention" />}
                  </Link>
                  {item.active && !!item.sub?.length && (
                    <div className="mt-0.5 mb-1 ml-[1.15rem] flex flex-col gap-px border-l border-line pl-2.5">
                      {item.sub.map((s) => (
                        <Link key={s.href} href={s.href} prefetch aria-current={s.active ? "page" : undefined} className={subLinkClass(s)}>
                          {s.label}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          );
        })
      )}
    </nav>
  );
}

/** Narrow screens: one button with the current page that opens every page, the open page's own pages included. */
export function ServicePicker({ items }: { items: ServiceNavItem[] }) {
  const open = items.find((i) => i.active && i.sub?.length);
  return (
    <SectionPicker
      className="lg:hidden"
      groups={[
        ...GROUPS.map((group) => ({
          title: group,
          items: items.filter((i) => i.group === group && i !== open).map((i) => ({ href: i.to ?? i.href, label: i.label, active: i.active, warn: !!i.issue })),
        })).filter((g) => g.items.length),
        ...[...new Set((open?.sub ?? []).map((s) => s.group ?? ""))].map((g) => ({
          title: g ? `${open!.label} · ${g}` : open!.label,
          items: (open?.sub ?? []).filter((s) => (s.group ?? "") === g),
        })),
      ]}
    />
  );
}
