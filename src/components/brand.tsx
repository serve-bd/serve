"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { DEFAULT_PRODUCT_NAME } from "@/lib/branding";
import type { Brand } from "@/server/branding";

const fallback: Brand = { name: DEFAULT_PRODUCT_NAME, showName: true, logoUrl: null, logoDarkUrl: null, faviconUrl: null, accentCss: null };
const BrandContext = React.createContext<Brand>(fallback);

export function BrandProvider({ brand, children }: { brand: Brand; children: React.ReactNode }) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export function useBrand() {
  return React.useContext(BrandContext);
}

/** The product name (white-label). */
export function useProductName() {
  return useBrand().name;
}

/** Default mark: a rack unit with a lit status lamp. */
function DefaultMark({ className, onDark }: { className?: string; onDark?: boolean }) {
  return (
    <svg viewBox="0 0 28 28" className={cn("size-7", className)} aria-hidden>
      <rect x="1" y="1" width="26" height="26" rx="7" className={onDark ? "fill-white" : "fill-fg"} />
      <rect x="6" y="8" width="16" height="4" rx="1.5" className={onDark ? "fill-[#07070a]" : "fill-bg"} opacity="0.9" />
      <rect x="6" y="16" width="16" height="4" rx="1.5" className={onDark ? "fill-[#07070a]" : "fill-bg"} opacity="0.55" />
      <circle cx="19" cy="10" r="1.4" fill="var(--accent)" />
    </svg>
  );
}

/**
 * The brand: an uploaded logo (with its dark mode version) or the default mark, and the
 * product name. `brand` overrides the context, for previews.
 */
export function Logo({
  className,
  withText = true,
  markClassName,
  logoClassName,
  textClassName,
  brand: override,
  onDark,
}: {
  className?: string;
  withText?: boolean;
  /** Size of the default mark, like "size-8". */
  markClassName?: string;
  /** Size of an uploaded logo, like "h-8". */
  logoClassName?: string;
  textClassName?: string;
  brand?: Brand;
  /** Always on a dark surface (like the sign-in brand panel): use the dark mode logo when there is one. */
  onDark?: boolean;
}) {
  const context = useBrand();
  const base = override ?? context;
  const brand = onDark && base.logoDarkUrl ? { ...base, logoUrl: base.logoDarkUrl, logoDarkUrl: null } : base;
  const showText = withText && (brand.logoUrl ? brand.showName : true);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      {brand.logoUrl ? (
        <>
          {/* Logos are only ever drawn through <img>, so an SVG cannot run scripts. */}
          <img
            src={brand.logoUrl}
            alt={showText ? "" : brand.name}
            className={cn("h-7 w-auto max-w-[160px] object-contain", brand.logoDarkUrl && "dark:hidden", logoClassName)}
            draggable={false}
          />
          {brand.logoDarkUrl && (
            <img
              src={brand.logoDarkUrl}
              alt={showText ? "" : brand.name}
              className={cn("hidden h-7 w-auto max-w-[160px] object-contain dark:block", logoClassName)}
              draggable={false}
            />
          )}
        </>
      ) : (
        <DefaultMark className={markClassName} onDark={onDark} />
      )}
      {showText && <span className={cn("truncate font-display text-[17px] font-semibold tracking-tight text-fg", textClassName)}>{brand.name}</span>}
    </span>
  );
}

/** The product name as text, for server and client components alike. */
export function ProductName() {
  return <>{useBrand().name}</>;
}
