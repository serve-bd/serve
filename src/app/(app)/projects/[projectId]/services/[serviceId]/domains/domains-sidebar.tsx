"use client";

import Link from "next/link";
import { SectionPicker } from "@/components/shell/section-picker";
import { cn } from "@/lib/utils";

export type DomainsSectionItem = { id: string; label: string };

/** The sections of Domains & ports: one shows at a time, chosen by ?section= (the first by default). */
export function DomainsSidebar({ base, nav, current }: { base: string; nav: DomainsSectionItem[]; current: string }) {
  const href = (id: string) => (id === nav[0]?.id ? base : `${base}?section=${id}`);
  return (
    <>
      <SectionPicker className="xl:hidden" groups={[{ items: nav.map((item) => ({ href: href(item.id), label: item.label, active: item.id === current })) }]} />
      <nav aria-label="Domains & ports sections" className="sticky top-6 hidden w-44 flex-none flex-col gap-0.5 self-start xl:flex">
        {nav.map((item) => {
          const active = item.id === current;
          return (
            <Link
              key={item.id}
              href={href(item.id)}
              prefetch
              scroll={false}
              aria-current={active ? "page" : undefined}
              className={cn(
                "rounded-lg px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors",
                active ? "bg-fg/[0.06] text-fg" : "text-fg-2/80 hover:bg-fg/[0.04] hover:text-fg",
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
