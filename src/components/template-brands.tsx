"use client";

import * as React from "react";

/**
 * Brand tiles for one-click templates. The catalog (and so each tile's colour and logo) comes from
 * the server; templates it does not know and organization templates get a lettered tile in a
 * colour picked from their name.
 */
export type TemplateBrand = { color: string; logo: string | null };

const BrandsContext = React.createContext<Record<string, TemplateBrand>>({});

export function TemplateBrandsProvider({ brands, children }: { brands: Record<string, TemplateBrand>; children: React.ReactNode }) {
  return <BrandsContext.Provider value={brands}>{children}</BrandsContext.Provider>;
}

const palette = ["#2563EB", "#7C3AED", "#DB2777", "#EA580C", "#16A34A", "#0891B2", "#4F46E5", "#B45309"];

function lettered(name: string): TemplateBrand {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { color: palette[h % palette.length], logo: null };
}

/** Tile colour and logo for a template id (built-in) or any other name (custom). */
export function useTemplateBrand(id: string): TemplateBrand {
  const brands = React.useContext(BrandsContext);
  return brands[id] ?? lettered(id);
}
