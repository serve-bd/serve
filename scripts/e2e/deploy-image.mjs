// Creates an image service through the UI and waits for the deployment.
import { chromium } from "playwright-core";
const base = process.env.BASE ?? "http://localhost:3001";
const state = `/tmp/claude-1000/e2e-state-${new URL(base).port}.json`;
const image = process.argv[2] ?? "traefik/whoami:latest";
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: state, colorScheme: "dark" });
await ctx.addInitScript(() => { window.__SERVE_E2E__ = true; });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.goto(base + "/projects", { waitUntil: "networkidle" });
await page.locator('a[href^="/projects/"]:not([href="/projects/new"])').first().click();
await page.waitForURL(/\/projects\/[a-z0-9]+/);
await page.getByRole("link", { name: "New service" }).first().click();
await page.getByRole("button", { name: /Docker image/ }).click();
await page.getByPlaceholder("traefik/whoami:latest").fill(image);
await page.screenshot({ path: "/tmp/claude-1000/new-image.png" });
await page.getByRole("button", { name: "Deploy" }).click();
await page.waitForURL(/\/services\/[a-z0-9]+$/, { timeout: 30000 });
const started = Date.now();
while (Date.now() - started < 180000) {
  const status = await page.locator("header").getByText(/Running|Failed|Deploying|Building|Not deployed/).first().textContent().catch(() => "");
  if (/Running|Failed/.test(status ?? "")) {
    console.log("status:", status);
    break;
  }
  await page.waitForTimeout(1500);
}
await page.waitForTimeout(800);
await page.screenshot({ path: "/tmp/claude-1000/service.png" });
console.log("url:", page.url());
await browser.close();
