import { designOf } from "@/lib/status-page";
import { statusView } from "@/server/status-pages/data";
import { publicPage } from "@/server/status-pages/public";

export const dynamic = "force-dynamic";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Incidents and maintenance as RSS, newest first: readers and chat apps can follow the page. */
export async function GET(request: Request, ctx: RouteContext<"/status/[slug]/feed.xml">) {
  const { slug } = await ctx.params;
  const found = await publicPage(slug);
  if (found?.access !== "open") return new Response("Not found", { status: 404 });
  // At least a month of history, whatever the page shows.
  const design = { ...designOf(found.page.design), historyDays: Math.max(30, designOf(found.page.design).historyDays) };
  const view = await statusView(found.page, found.base, design);
  // Behind the proxy the request URL is the app's own address: the visitor's host is in Host.
  const host = request.headers.get("host");
  const origin = host ? `${request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "")}://${host}` : new URL(request.url).origin;
  const link = `${origin}${found.base || "/"}`;
  const items = [...view.active, ...view.upcoming, ...view.history.flatMap((d) => d.notices)]
    .filter((n, i, all) => all.findIndex((x) => x.id === n.id) === i)
    .map((n) => {
      const body = [`${n.state}${n.components.length ? ` · ${n.components.join(", ")}` : ""}`, ...n.updates.map((u) => `${u.state}: ${u.body}`)].join("\n\n");
      const date = new Date(n.updates[0]?.at ?? n.resolvedAt ?? n.startsAt ?? view.generatedAt).toUTCString();
      return `<item><title>${esc(n.title)}</title><link>${esc(link)}</link><guid isPermaLink="false">${esc(`${n.id}:${n.state}:${n.updates.length}`)}</guid><pubDate>${date}</pubDate><description>${esc(body)}</description></item>`;
    });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${esc(`${view.name} status`)}</title><link>${esc(link)}</link><description>${esc(`Incidents and maintenance of ${view.name}`)}</description>${items.join("")}</channel></rss>\n`;
  return new Response(xml, { headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=60" } });
}
