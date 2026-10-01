import { templateLogo } from "@/server/services/templates";

/** A template's logo from the catalog (headers in next.config.ts). The URL carries the logo's hash, so it can be cached. */
export async function GET(_req: Request, ctx: RouteContext<"/api/templates/[id]/logo">) {
  const { id } = await ctx.params;
  const svg = await templateLogo(id);
  if (!svg) return new Response("Not found", { status: 404 });
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "private, max-age=86400",
    },
  });
}
