"use client";

import { useTemplateBrand } from "@/components/template-brands";
import { cn } from "@/lib/utils";

/** Rounded brand tile for a template: logo, custom image or a lettered tile. */
export function TemplateLogo({
  id,
  name,
  iconUrl,
  custom = false,
  size = "md",
  className,
}: {
  id: string;
  name: string;
  iconUrl?: string | null;
  custom?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const brand = useTemplateBrand(custom ? name.toLowerCase() : id);
  const dims = { sm: "size-7 rounded-lg text-[12px]", md: "size-10 rounded-xl text-[15px]", lg: "size-12 rounded-[14px] text-[17px]" }[size];
  if (iconUrl) {
    return (
      <span className={cn("flex shrink-0 items-center justify-center overflow-hidden border border-line bg-surface-2 shadow-sm", dims, className)}>
        <img src={iconUrl} alt="" className="size-[70%] object-contain" draggable={false} />
      </span>
    );
  }
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center font-semibold text-white shadow-sm", dims, className)}
      style={{ background: `linear-gradient(160deg, color-mix(in oklab, ${brand.color} 86%, white), ${brand.color})` }}
      aria-hidden
    >
      {brand.logo && !custom ? <img src={brand.logo} alt="" className="size-[54%]" draggable={false} /> : name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
