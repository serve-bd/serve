import type { NextRequest } from "next/server";
import { designOf } from "@/lib/status-page";
import { basePathFor } from "./public";
import { subscriberByToken } from "./subscribers";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The small pages behind the links in emails (confirm, unsubscribe). A link only shows a button:
 * mail scanners open links on their own, and must not confirm or unsubscribe anyone by doing so.
 */
export function linkPage(opts: { page: { name: string; design: unknown }; title: string; text: string; button?: { label: string; action: string }; back: string }) {
  const design = designOf(opts.page.design as never);
  const accent = design.accent ?? "#14161a";
  const scheme = design.theme === "auto" ? "light dark" : design.theme;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(opts.title)} · ${esc(opts.page.name)}</title>
<style>
:root{color-scheme:${scheme};--bg:#f6f7f9;--fg:#14161a;--muted:#6b7079;--card:#fff;--line:rgb(20 22 26/.09)}
@media (prefers-color-scheme:dark){:root{${design.theme === "light" ? "" : "--bg:#0c0d10;--fg:#f2f3f5;--muted:#8b9099;--card:#15171b;--line:rgb(255 255 255/.08)"}}}
${design.theme === "dark" ? ":root{--bg:#0c0d10;--fg:#f2f3f5;--muted:#8b9099;--card:#15171b;--line:rgb(255 255 255/.08)}" : ""}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
main{max-width:400px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;text-align:center}
.name{font-size:13px;color:var(--muted);margin:0 0 10px}h1{font-size:20px;margin:0 0 8px}p{color:var(--muted);margin:0 0 18px}
button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:10px 18px;background:${esc(accent)};color:#fff;cursor:pointer}
a{color:var(--muted);font-size:13px}
</style></head><body><main>
<p class="name">${esc(opts.page.name)}</p><h1>${esc(opts.title)}</h1><p>${esc(opts.text)}</p>
${opts.button ? `<form method="post" action="${esc(opts.button.action)}"><button type="submit">${esc(opts.button.label)}</button></form><p style="margin:18px 0 0"><a href="${esc(opts.back)}">Back to the status page</a></p>` : `<a href="${esc(opts.back)}">Back to the status page</a>`}
</main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

type Ctx = { params: Promise<{ slug: string }> };

/**
 * GET and POST of a link route (confirm, unsubscribe): GET shows the button, POST does `act`.
 * The token must belong to the page in the path.
 */
export function linkRoute(o: { path: string; title: string; text: string; button: string; doneTitle: string; doneText: string; act: (subscriberId: string) => Promise<void> }) {
  const lookup = async (request: NextRequest, ctx: Ctx) => {
    const { slug } = await ctx.params;
    const token = request.nextUrl.searchParams.get("token") ?? "";
    const found = await subscriberByToken(token);
    if (!found || found.page.slug !== slug.toLowerCase()) return null;
    return { ...found, token, base: (await basePathFor(found.page)) || "/" };
  };
  const gone = () => new Response("This link is not valid any more.", { status: 404 });
  return {
    GET: async (request: NextRequest, ctx: Ctx) => {
      const f = await lookup(request, ctx);
      if (!f) return gone();
      const action = `${f.base === "/" ? "" : f.base}/${o.path}?token=${encodeURIComponent(f.token)}`;
      return linkPage({ page: f.page, title: o.title, text: o.text, button: { label: o.button, action }, back: f.base });
    },
    POST: async (request: NextRequest, ctx: Ctx) => {
      const f = await lookup(request, ctx);
      if (!f) return gone();
      await o.act(f.subscriber.id);
      return linkPage({ page: f.page, title: o.doneTitle, text: o.doneText, back: f.base });
    },
  };
}
