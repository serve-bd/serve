import { pageBySlug } from "@/server/status-pages/data";

/**
 * A script to put on any website: it shows the page's status as a small pill (or a banner during
 * incidents) that links to the page. It reads summary.json, so it works for public pages only.
 * Options as attributes on the script tag:
 *   data-position="bottom-right" | "bottom-left" | "top"   (top: a bar over the site, only during issues)
 *   data-only-issues="true"                                  (hide the pill while all is fine)
 *   data-theme="light" | "dark"                              (default: the visitor's)
 */
const SCRIPT = `(() => {
  const script = document.currentScript;
  if (!script) return;
  const base = script.src.replace(/\\/widget\\.js(\\?.*)?$/, "");
  const position = script.dataset.position || "bottom-right";
  const onlyIssues = script.dataset.onlyIssues === "true" || position === "top";
  const theme = script.dataset.theme;
  const COLORS = { operational: "#1a9a52", maintenance: "#2f6fdb", degraded: "#c47a00", partial: "#e0601b", major: "#d9342b", unknown: "#8b9099" };
  const host = document.createElement("div");
  host.setAttribute("data-serve-status", "");
  const root = host.attachShadow({ mode: "open" });
  const dark = theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  const bg = dark ? "#15171b" : "#ffffff", fg = dark ? "#f2f3f5" : "#14161a", line = dark ? "rgba(255,255,255,.1)" : "rgba(20,22,26,.12)";
  const place = position === "top" ? "top:0;left:0;right:0;" : position === "bottom-left" ? "bottom:16px;left:16px;" : "bottom:16px;right:16px;";
  root.innerHTML = '<style>:host{all:initial}a{position:fixed;' + place + 'z-index:2147483000;display:flex;align-items:center;gap:8px;text-decoration:none;font:500 13px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;color:' + fg + ';background:' + bg + ';border:1px solid ' + line + ';box-shadow:0 6px 24px -8px rgba(0,0,0,.25);' + (position === "top" ? "justify-content:center;padding:10px 16px;border-width:0 0 1px;" : "border-radius:999px;padding:8px 14px 8px 11px;") + '}a:hover{filter:brightness(' + (dark ? "1.15" : ".97") + ')}i{width:9px;height:9px;border-radius:50%;flex:none}span{max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}</style><a target="_blank" rel="noopener" hidden><i></i><span></span></a>';
  const link = root.querySelector("a"), dot = root.querySelector("i"), text = root.querySelector("span");
  link.href = base + "/";
  const load = () =>
    fetch(base + "/summary.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        const level = d.status.level;
        const fine = level === "operational" || level === "unknown";
        const ongoing = d.ongoing && d.ongoing[0];
        link.hidden = onlyIssues && fine;
        dot.style.background = COLORS[level] || COLORS.unknown;
        text.textContent = position === "top" && ongoing ? ongoing.title : d.status.description;
        link.title = d.page.name;
      })
      .catch(() => {});
  (document.body || document.documentElement).appendChild(host);
  load();
  setInterval(load, 120000);
})();
`;

export async function GET(_request: Request, ctx: RouteContext<"/status/[slug]/widget.js">) {
  const { slug } = await ctx.params;
  const page = await pageBySlug(slug);
  // Only a public page: the widget runs on other sites, where no password or session reaches.
  if (!page || page.visibility !== "public")
    return new Response("/* Status page not found or not public. */\n", { status: 404, headers: { "content-type": "application/javascript; charset=utf-8" } });
  return new Response(SCRIPT, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });
}
