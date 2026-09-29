// Screenshots every page at several widths and reports horizontal overflow.
// Usage: BASE=http://localhost:3001 OUT=/tmp/resp node scripts/e2e/responsive.mjs [route...]
import { chromium } from "playwright-core";
import fs from "node:fs";

const base = process.env.BASE ?? "http://localhost:3001";
const outDir = process.env.OUT ?? "/tmp/claude-1000/resp";
const widths = (process.env.WIDTHS ?? "390,768,1024").split(",").map(Number);
const P = process.env.P, S = process.env.S, DB = process.env.DB, C = process.env.C, DEP = process.env.DEP;
const routes = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "/", "/projects", "/projects/new", "/domains", "/certificates", "/activity", "/server", "/account",
      "/organization", "/organization/members", "/organization/tokens",
      "/integrations/git", "/integrations/cloudflare", "/integrations/storage", "/integrations/notifications",
      `/projects/${P}`, `/projects/${P}/new`, `/projects/${P}/settings`,
      `/projects/${P}/services/${S}`, `/projects/${P}/services/${S}/logs`, `/projects/${P}/services/${S}/console`,
      `/projects/${P}/services/${S}/metrics`, `/projects/${P}/services/${S}/variables`, `/projects/${P}/services/${S}/domains`,
      `/projects/${P}/services/${S}/tasks`, `/projects/${P}/services/${S}/settings`,
      `/projects/${P}/services/${S}/deployments/${DEP}`,
      `/projects/${P}/services/${DB}`, `/projects/${P}/services/${DB}/backups`, `/projects/${P}/services/${DB}/settings`,
      `/projects/${P}/services/${C}`, `/projects/${P}/services/${C}/settings`,
    ];
fs.mkdirSync(outDir, { recursive: true });
const state = `/tmp/claude-1000/e2e-state-${new URL(base).port}.json`;
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });

for (const width of widths) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "dark", storageState: fs.existsSync(state) ? state : undefined });
await ctx.addInitScript(() => { window.__SERVE_E2E__ = true; });
  await ctx.addInitScript(() => { try { localStorage.setItem("serve-theme", "dark"); } catch {} });
  const page = await ctx.newPage();
  await page.goto(base + "/login", { waitUntil: "networkidle" });
  if (page.url().includes("/login")) {
    await page.fill('input[name="email"]', process.env.EMAIL ?? "owner@serve.test");
    await page.fill('input[name="password"]', process.env.PASSWORD ?? "owner-pass-123");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));
    await ctx.storageState({ path: state });
  }
  for (const route of routes) {
    await page.goto(base + route, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(500);
    const report = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const scrollW = document.documentElement.scrollWidth;
      const scrollable = (el) => {
        for (let p = el.parentElement; p; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (/(auto|scroll|hidden|clip)/.test(s.overflowX) && p !== document.body && p !== document.documentElement) return true;
        }
        return false;
      };
      const offenders = [];
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > vw + 1 || r.left < -1) {
          if (scrollable(el)) continue;
          if (getComputedStyle(el).position === "fixed") continue;
          const cls = typeof el.className === "string" ? el.className.slice(0, 90) : "";
          offenders.push(`${el.tagName.toLowerCase()}.${cls} [${Math.round(r.left)}→${Math.round(r.right)}] "${(el.textContent ?? "").trim().slice(0, 40)}"`);
        }
      }
      // Clipped text inside overflow-hidden containers (content wider than box).
      const clipped = [];
      for (const el of document.querySelectorAll("main *")) {
        const s = getComputedStyle(el);
        if (s.overflowX === "hidden" && el.scrollWidth > el.clientWidth + 2 && s.textOverflow !== "ellipsis" && el.children.length > 0) {
          const cls = typeof el.className === "string" ? el.className.slice(0, 80) : "";
          clipped.push(`${el.tagName.toLowerCase()}.${cls} (${el.scrollWidth}>${el.clientWidth})`);
        }
      }
      return { vw, scrollW, offenders: offenders.slice(0, 8), clipped: clipped.slice(0, 5) };
    });
    const name = `${width}${route.replace(/[^a-z0-9]+/gi, "_")}.png`;
    await page.screenshot({ path: `${outDir}/${name}`, fullPage: true });
    const bad = report.scrollW > report.vw || report.offenders.length || report.clipped.length;
    console.log(`${bad ? "✗" : "✓"} ${width} ${route}${report.scrollW > report.vw ? ` scroll ${report.scrollW}>${report.vw}` : ""}`);
    for (const o of report.offenders) console.log("    over:", o);
    for (const o of report.clipped) console.log("    clip:", o);
  }
  await ctx.close();
}
await browser.close();
