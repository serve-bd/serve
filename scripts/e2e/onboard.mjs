// Completes onboarding on the e2e instance.
import { chromium } from "playwright-core";
const base = process.env.BASE ?? "http://localhost:3001";
const state = `/tmp/claude-1000/e2e-state-${new URL(base).port}.json`;
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: state });
await ctx.addInitScript(() => {
  window.__SERVE_E2E__ = true;
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.goto(base + "/onboarding", { waitUntil: "networkidle" });
const cont = () => page.getByRole("button", { name: /Continue|Finish setup/ }).click();
await cont(); // server
await page.getByText("Choose domains").waitFor();
await page.screenshot({ path: "/tmp/claude-1000/onb-2.png" });
await cont(); // domains
await page.getByText("Set up HTTPS").waitFor();
await page.screenshot({ path: "/tmp/claude-1000/onb-3.png" });
await cont(); // ssl
await page.getByText("Connect Cloudflare").first().waitFor();
await page.screenshot({ path: "/tmp/claude-1000/onb-4.png" });
await page.getByRole("button", { name: "Skip for now" }).click();
await page.getByText("Connect a git provider").waitFor();
await page.getByRole("button", { name: "Skip for now" }).click();
await page.getByText("Create your first project").waitFor();
await page.screenshot({ path: "/tmp/claude-1000/onb-6.png" });
await cont();
await page.waitForURL((u) => u.pathname.startsWith("/projects/"), { timeout: 30000 });
console.log("done:", page.url());
await browser.close();
