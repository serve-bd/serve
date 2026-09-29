"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BellRing,
  Boxes,
  Brush,
  Download,
  Globe,
  HardDriveDownload,
  KeyRound,
  LockKeyhole,
  Mail,
  Network,
  Palette,
  Building2,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  Waypoints,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionPicker } from "./section-picker";

/** Icons by name, so server layouts can describe navigation without passing components. */
const icons = {
  Activity,
  BellRing,
  Boxes,
  Brush,
  Download,
  Globe,
  HardDriveDownload,
  KeyRound,
  LockKeyhole,
  Mail,
  Network,
  Palette,
  Building2,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  Waypoints,
};

export type SectionNavItem = { href: string; label: string; icon: keyof typeof icons; warn?: boolean; exact?: boolean };
export type SectionNavGroup = { title: string; items: SectionNavItem[] };

/** Side navigation for a settings-like section; a section picker below `lg`. */
export function SectionNav({ groups }: { groups: SectionNavGroup[] }) {
  const pathname = usePathname();
  const isActive = (item: SectionNavItem) => (item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`));

  return (
    <>
      <SectionPicker
        className="lg:hidden"
        groups={groups.map((g) => ({ title: g.title, items: g.items.map((item) => ({ href: item.href, label: item.label, warn: item.warn, active: isActive(item) })) }))}
      />

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
