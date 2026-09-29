// Visits every page, reports console/page errors and HTTP failures, saves screenshots.
import { chromium } from "playwright-core";
import fs from "node:fs";
const base = process.env.BASE ?? "http://localhost:3001";
const state = `/tmp/claude-1000/e2e-state-${new URL(base).port}.json`;
const outDir = "/tmp/claude-1000/smoke";
fs.mkdirSync(outDir, { recursive: true });
const theme = process.env.THEME ?? "light";
const mobile = process.env.MOBILE === "1";
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, storageState: state });
await ctx.addInitScript(() => { window.__SERVE_E2E__ = true; });
await ctx.addInitScript((t) => { try { localStorage.setItem("serve-theme", t); } catch {} }, theme);
const page = await ctx.newPage();
const routes = process.argv.slice(2);
let failures = 0;
for (const route of routes) {
  const errors = [];
  const onConsole = (m) => m.type() === "error" && errors.push(m.text());
  const onError = (e) => errors.push(e.message);
  const onResponse = (r) => r.status() >= 500 && errors.push(`${r.status()} ${r.url()}`);
  page.on("console", onConsole);
  page.on("pageerror", onError);
  page.on("response", onResponse);
  const res = await page.goto(base + route, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => (errors.push(e.message), null));
  await page.waitForTimeout(600);
  const name = route.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "root";
  await page.screenshot({ path: `${outDir}/${name}${mobile ? "-m" : ""}-${theme}.png`, fullPage: true });
  const status = res?.status() ?? 0;
  const bad = status >= 400 || errors.length;
  if (bad) failures++;
  console.log(`${bad ? "FAIL" : "ok  "} ${status} ${route}${errors.length ? "\n     " + [...new Set(errors)].slice(0, 4).join("\n     ") : ""}`);
  page.off("console", onConsole);
  page.off("pageerror", onError);
  page.off("response", onResponse);
}
await browser.close();
process.exit(failures ? 1 : 0);
