import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { readBrandAsset } from "@/server/branding";
import { db, schema } from "@/server/db";

/**
 * The page's tab icon: its favicon, else its logo, else the instance's branding icon or logo.
 * Served by the page itself: on its own domain the dashboard's icon paths do not answer.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/status/[slug]/icon">) {
  const { slug } = await ctx.params;
  const [row] = await db.select({ images: schema.statusPage.images }).from(schema.statusPage).where(eq(schema.statusPage.slug, slug.toLowerCase()));
  if (!row) return new Response("Not found", { status: 404 });
  const image = row.images.favicon ?? row.images.logo ?? (await readBrandAsset("favicon")) ?? (await readBrandAsset("logo"));
  // Nothing uploaded anywhere: the default icon, which every domain serves as a static file.
  if (!image) return Response.redirect(new URL("/icon.svg", request.url), 307);
  const etag = `"${image.hash}"`;
  const headers: Record<string, string> = {
    "content-type": image.mime,
    etag,
    "cache-control": request.nextUrl.searchParams.get("v") === image.hash ? "public, max-age=31536000, immutable" : "public, max-age=300",
    "x-content-type-options": "nosniff",
  };
  if (image.mime === "image/svg+xml") headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(Buffer.from(image.data, "base64"), { headers });
}
