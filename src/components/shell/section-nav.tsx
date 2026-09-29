"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Boxes,
  Brush,
  Globe,
  KeyRound,
  LockKeyhole,
  Network,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
} from "lucide-react";
import { cn } from "@/lib/utils";

/** Icons by name, so server layouts can describe navigation without passing components. */
const icons = { Activity, Boxes, Brush, Globe, KeyRound, LockKeyhole, Network, Settings2, ShieldCheck, SlidersHorizontal, SquareTerminal };

export type SectionNavItem = { href: string; label: string; icon: keyof typeof icons; warn?: boolean; exact?: boolean };
export type SectionNavGroup = { title: string; items: SectionNavItem[] };

/** Side navigation for a settings-like section; a scrollable row of pills below `lg`. */
export function SectionNav({ groups }: { groups: SectionNavGroup[] }) {
  const pathname = usePathname();
  const isActive = (item: SectionNavItem) => (item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`));

  return (
    <>
      <nav className="scrollbar-none -mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 pb-3 lg:hidden">
        {groups.flatMap((g) => g.items).map((item) => {
          const active = isActive(item);
          return (
            <Link
              key={item.href}
              href={item.href}
              ref={active ? (el) => el?.scrollIntoView({ block: "nearest", inline: "nearest" }) : undefined}
              className={cn(
                "relative flex h-8 flex-none items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium whitespace-nowrap transition-colors",
                active ? "bg-fg/[0.07] text-fg" : "text-muted hover:bg-fg/[0.04] hover:text-fg",
              )}
            >
              {item.label}
              {item.warn && <span className="size-1.5 rounded-full bg-warn" />}
            </Link>
          );
        })}
      </nav>

      <nav className="sticky top-6 hidden w-[208px] flex-none flex-col gap-5 self-start lg:flex">
        {groups.map((g) => (
          <div key={g.title} className="flex flex-col gap-0.5">
            <p className="px-2.5 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">{g.title}</p>
            {g.items.map((item) => {
              const active = isActive(item);
              const Icon = icons[item.icon];
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors",
                    active ? "bg-fg/[0.06] text-fg" : "text-fg-2/80 hover:bg-fg/[0.04] hover:text-fg",
                  )}
                >
                  <Icon className={cn("size-4 shrink-0", active ? "text-accent" : "text-muted group-hover:text-fg-2")} />
                  <span className="flex-1">{item.label}</span>
                  {item.warn && <span className="size-1.5 rounded-full bg-warn" />}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </>
  );
}
