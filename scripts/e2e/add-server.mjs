// Adds a server through the UI against the fake remote (scripts/e2e/remote/run.sh).
// Usage: BASE=http://localhost:3001 OUT=<dir> node scripts/e2e/add-server.mjs
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const base = process.env.BASE ?? "http://localhost:3001";
const out = process.env.OUT ?? "/tmp/claude-1000";
const width = Number(process.env.WIDTH ?? 1280);
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "dark", storageState: `/tmp/claude-1000/e2e-state-${new URL(base).port}.json` });
await ctx.addInitScript(() => {
  window.__SERVE_E2E__ = true;
});
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${base}/servers/new`, { waitUntil: "networkidle" });
const name = `ui-test-${Date.now().toString(36)}`;
await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
await page.getByLabel("IP address or hostname").fill("127.0.0.1");
await page.getByLabel("SSH port").fill("2222");
await page.getByRole("button", { name: /Continue/ }).click();

await page.getByRole("radio", { name: /Generate new/ }).click();
await page.getByRole("button", { name: "Generate key" }).click();
const pub = await page.locator("code", { hasText: "ssh-ed25519" }).first().textContent();
if (!pub?.startsWith("ssh-ed25519")) throw new Error("no public key shown");
await page.screenshot({ path: `${out}/add-server-key-${width}.png`, fullPage: true });
execFileSync("docker", ["exec", "serve-e2e-remote", "sh", "-c", `echo "${pub.trim()}" >> /root/.ssh/authorized_keys`]);
console.log("authorized", pub.slice(0, 40));

await page.getByRole("button", { name: /I added the key, connect/ }).click();
await page
  .getByText(/Connecting and preparing|Waiting for the worker/)
  .first()
  .waitFor({ timeout: 15000 });
await page.screenshot({ path: `${out}/add-server-progress-${width}.png`, fullPage: true });
const done = await Promise.race([
  page
    .getByText("Connected. The server is ready.")
    .waitFor({ timeout: 180000 })
    .then(() => "ready"),
  page
    .getByText(/Could not finish the setup|Docker is not installed/)
    .waitFor({ timeout: 180000 })
    .then(() => "failed"),
]);
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/add-server-done-${width}.png`, fullPage: true });
console.log("result:", done);
await page.getByRole("link", { name: /Open server/ }).click();
await page.waitForURL(/\/servers\/(?!new$)[a-z0-9]+$/);
console.log("server page:", page.url());
fs.writeFileSync(`${out}/add-server-id.txt`, page.url().split("/").pop());
if (errors.length) console.log("errors:", errors);
await browser.close();
