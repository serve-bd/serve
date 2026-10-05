import { designOf, LEVEL_TEXT, type StatusLevel } from "@/lib/status-page";
import { statusView } from "@/server/status-pages/data";
import { publicPage } from "@/server/status-pages/public";

export const dynamic = "force-dynamic";

const COLOR: Record<StatusLevel, string> = { operational: "#1a9a52", maintenance: "#2f6fdb", degraded: "#c47a00", partial: "#e0601b", major: "#d9342b", unknown: "#8b9099" };
const SHORT: Record<StatusLevel, string> = {
  operational: "operational",
  maintenance: "maintenance",
  degraded: "degraded",
  partial: "partial outage",
  major: "major outage",
  unknown: "no data",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Rough width of text at 11px: good enough for a badge. */
const width = (s: string) => Math.round(s.length * 6.4 + 12);

/** An SVG badge for a README or a website: the page's status, or one component's with ?component=<id>. */
export async function GET(request: Request, ctx: RouteContext<"/status/[slug]/badge">) {
  const { slug } = await ctx.params;
  const found = await publicPage(slug);
  if (found?.access !== "open") return new Response("Not found", { status: 404 });
  const view = await statusView(found.page, found.base, { ...designOf(found.page.design), autoIncidents: false, historyDays: 0, days: 30 });
  const params = new URL(request.url).searchParams;
  const componentId = params.get("component");
  const component = componentId ? view.groups.flatMap((g) => g.components).find((c) => c.id === componentId) : null;
  if (componentId && !component) return new Response("Not found", { status: 404 });
  const level = component?.level ?? view.overall;
  const label = params.get("label")?.slice(0, 40) || (component ? component.name : "status");
  const value = SHORT[level];
  const [lw, vw] = [width(label), width(value)];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${esc(`${label}: ${LEVEL_TEXT[level]}`)}"><title>${esc(`${label}: ${LEVEL_TEXT[level]}`)}</title><clipPath id="r"><rect width="${lw + vw}" height="20" rx="3"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#3b3f46"/><rect x="${lw}" width="${vw}" height="20" fill="${COLOR[level]}"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>`;
  return new Response(svg, { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=60", "x-content-type-options": "nosniff" } });
}
