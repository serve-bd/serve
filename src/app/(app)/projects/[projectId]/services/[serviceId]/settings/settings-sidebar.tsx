"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SectionPicker } from "@/components/shell/section-picker";
import { cn } from "@/lib/utils";
import type { SettingsNavItem } from "./settings-nav";

/** The settings sections. It lives in the layout, so it stays on screen while a section loads. */
export function SettingsSidebar({ base, nav, label = "Settings sections" }: { base: string; nav: SettingsNavItem[]; label?: string }) {
  // An item with id "" is the base page itself.
  const href = (id: string) => (id ? `${base}/${id}` : base);
  const section = usePathname()
    .slice(base.length + 1)
    .split("/")[0];
  return (
    <>
      <SectionPicker
        className="xl:hidden"
        groups={[{ items: nav.map((item) => ({ href: href(item.id), label: item.label, active: item.id === section, danger: item.id === "danger" })) }]}
      />
      <nav aria-label={label} className="sticky top-6 hidden w-44 flex-none flex-col gap-0.5 self-start xl:flex">
        {nav.map((item) => {
          const active = item.id === section;
          return (
            <Link
              key={item.id}
              href={href(item.id)}
              // Sections are cheap to render: loaded ahead, switching between them is instant.
              prefetch
              aria-current={active ? "page" : undefined}
              className={cn(
                "rounded-lg px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors",
                active ? "bg-fg/[0.06] text-fg" : "text-fg-2/80 hover:bg-fg/[0.04] hover:text-fg",
                item.id === "danger" && (active ? "text-bad" : "text-bad/80 hover:text-bad"),
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
