import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db, schema } from "@/server/db";

/** A page's uploaded logo. Public even for a locked page: a logo is not a secret. */
export async function GET(request: NextRequest, ctx: RouteContext<"/status/[slug]/logo">) {
  const { slug } = await ctx.params;
  const [row] = await db.select({ images: schema.statusPage.images }).from(schema.statusPage).where(eq(schema.statusPage.slug, slug.toLowerCase()));
  const image = request.nextUrl.searchParams.get("dark") ? row?.images.logoDark : row?.images.logo;
  if (!image) return new Response("Not found", { status: 404 });
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
