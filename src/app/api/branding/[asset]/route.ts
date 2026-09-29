import type { NextRequest } from "next/server";
import { readBrandAsset } from "@/server/branding";
import type { BrandAssetKind } from "@/lib/branding";

export const dynamic = "force-dynamic";

const kinds: Record<string, BrandAssetKind> = { logo: "logo", "logo-dark": "logoDark", favicon: "favicon" };

/** Uploaded branding images. Public: the sign-in page shows the logo before anyone signs in. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/branding/[asset]">) {
  const { asset } = await ctx.params;
  const kind = kinds[asset];
  if (!kind) return new Response("Not found", { status: 404 });
  // Without its own favicon the logo stands in.
  const stored = (await readBrandAsset(kind)) ?? (kind === "favicon" ? await readBrandAsset("logo") : null);
  if (!stored) {
    if (kind === "favicon") return Response.redirect(new URL("/favicon.ico", request.url), 307);
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
  const etag = `"${stored.hash}"`;
  const versioned = request.nextUrl.searchParams.get("v") === stored.hash;
  const headers: Record<string, string> = {
    "content-type": stored.mime,
    etag,
    // A URL with the matching hash never changes; anything else is checked again soon.
    "cache-control": versioned ? "public, max-age=31536000, immutable" : "public, max-age=300, must-revalidate",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
  };
  // Opened on its own, an SVG could run scripts; this policy forbids everything but its own styles.
  if (stored.mime === "image/svg+xml") headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(Buffer.from(stored.data, "base64"), { headers });
}
