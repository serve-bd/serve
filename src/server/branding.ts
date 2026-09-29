import { cache } from "react";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { BRAND_ASSET_PREFIX, defaultSettings } from "@/server/settings";
import { type BrandAssetKind, type BrandImageMime, type BrandingConfig, DEFAULT_PRODUCT_NAME, accentCss, defaultBranding } from "@/lib/branding";

/** What pages need to draw the brand. Image URLs carry the content hash, so a new upload shows at once. */
export type Brand = {
  name: string;
  showName: boolean;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  faviconUrl: string | null;
  accentCss: string | null;
};

export const defaultBrand: Brand = { name: DEFAULT_PRODUCT_NAME, showName: true, logoUrl: null, logoDarkUrl: null, faviconUrl: null, accentCss: null };

const assetPath = { logo: "logo", logoDark: "logo-dark", favicon: "favicon" } as const;

export function brandFromConfig(name: string | null | undefined, config: BrandingConfig | null): Brand {
  const c = config ?? defaultBranding;
  const url = (kind: BrandAssetKind, hash: string) => `/api/branding/${assetPath[kind]}?v=${hash}`;
  // Without its own favicon the logo stands in; without either, the default icon.
  const icon = c.favicon ?? c.logo;
  return {
    name: name?.trim() || DEFAULT_PRODUCT_NAME,
    showName: c.logo ? c.showName : true,
    logoUrl: c.logo ? url("logo", c.logo.hash) : null,
    logoDarkUrl: c.logoDark ? url("logoDark", c.logoDark.hash) : null,
    faviconUrl: icon ? url("favicon", icon.hash) : null,
    accentCss: accentCss(c.accent),
  };
}

/** The brand, read once per request (two small rows). Falls back to the defaults when the database is not there, like during a build. */
export const getBrand = cache(async (): Promise<Brand> => {
  try {
    const rows = await db
      .select()
      .from(schema.setting)
      .where(inArray(schema.setting.key, ["instanceName", "branding"]));
    const value = (key: string) => rows.find((r) => r.key === key)?.value;
    return brandFromConfig((value("instanceName") as string | undefined) ?? defaultSettings.instanceName, (value("branding") as BrandingConfig | undefined) ?? null);
  } catch {
    return defaultBrand;
  }
});

/** Product name for server code outside a request (emails, notifications). */
export async function productName() {
  return (await getBrand()).name;
}

export type StoredBrandAsset = { mime: BrandImageMime; data: string; hash: string };

export async function readBrandAsset(kind: BrandAssetKind): Promise<StoredBrandAsset | null> {
  const [row] = await db
    .select()
    .from(schema.setting)
    .where(eq(schema.setting.key, `${BRAND_ASSET_PREFIX}${kind}`));
  return (row?.value as StoredBrandAsset | undefined) ?? null;
}

export async function writeBrandAsset(kind: BrandAssetKind, asset: StoredBrandAsset | null) {
  const key = `${BRAND_ASSET_PREFIX}${kind}`;
  if (!asset) {
    await db.delete(schema.setting).where(eq(schema.setting.key, key));
    return;
  }
  await db
    .insert(schema.setting)
    .values({ key, value: asset as never })
    .onConflictDoUpdate({ target: schema.setting.key, set: { value: asset as never, updatedAt: new Date() } });
}
