// Usage: BASE=http://localhost:3001 node scripts/e2e/shot.mjs <path> [out] [--light] [--mobile] [--full]
import { chromium } from "playwright-core";
import fs from "node:fs";

const [, , target = "/", out = "/tmp/claude-1000/shot.png", ...flags] = process.argv;
const base = process.env.BASE ?? "http://localhost:3001";
const email = process.env.EMAIL ?? "owner@serve.test";
const password = process.env.PASSWORD ?? "owner-pass-123";
const state = `/tmp/claude-1000/e2e-state-${new URL(base).port}.json`;

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const ctx = await browser.newContext({
  viewport: flags.includes("--mobile") ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  colorScheme: flags.includes("--light") ? "light" : "dark",
  storageState: fs.existsSync(state) ? state : undefined,
});
await ctx.addInitScript(() => { window.__SERVE_E2E__ = true; });
await ctx.addInitScript((theme) => {
  try { localStorage.setItem("serve-theme", theme); } catch {}
}, flags.includes("--light") ? "light" : "dark");
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(base + "/login", { waitUntil: "networkidle", timeout: 60000 });
if (page.url().includes("/setup")) {
  await page.fill('input[name="name"]', "Olivia Owner");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/setup"), { timeout: 60000 });
  await ctx.storageState({ path: state });
} else if (page.url().includes("/login")) {
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
  await ctx.storageState({ path: state });
}
await page.goto(base + target, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(Number(process.env.WAIT ?? 700));
await page.screenshot({ path: out, fullPage: flags.includes("--full") });
console.log("url:", page.url());
if (errors.length) console.log("errors:\n" + [...new Set(errors)].slice(0, 10).join("\n"));
await browser.close();
