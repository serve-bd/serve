// Proxy page flows on the fake remote: switch (mid-switch and after), dynamic configuration files,
// built-in defaults, container card and the per-service proxy config card.
// Usage: BASE=http://localhost:3001 node scripts/e2e/proxy-ui.mjs [serviceUrl]
import { chromium } from "playwright-core";
import fs from "node:fs";

const base = process.env.BASE ?? "http://localhost:3001";
const serviceUrl = process.argv[2] ?? null;
const out = "/tmp/claude-1000/proxy-ui";
fs.mkdirSync(out, { recursive: true });
const state = `/tmp/claude-1000/e2e-state-${new URL(base).port}.json`;
const results = [];
const ok = (cond, label, detail = "") => results.push(`${cond ? "✓" : "✗"} ${label}${detail ? `: ${detail}` : ""}`);

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
async function newPage(mobile = false) {
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    colorScheme: "dark",
    storageState: fs.existsSync(state) ? state : undefined,
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(base + "/login", { waitUntil: "networkidle", timeout: 90000 });
  if (page.url().includes("/login")) {
    await page.fill('input[name="email"]', process.env.EMAIL ?? "owner@serve.test");
    await page.fill('input[name="password"]', process.env.PASSWORD ?? "owner-pass-123");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
    await ctx.storageState({ path: state });
  }
  return page;
}
const confirmDialog = (page) =>
  page
    .getByRole("alertdialog")
    .or(page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Cancel" }) }))
    .last();

const page = await newPage();
const proxyUrl = `${base}/servers/e2eremote/proxy`;
if (!process.env.SKIP_PROXY) {
  await page.goto(proxyUrl, { waitUntil: "networkidle", timeout: 90000 });
  await page.screenshot({ path: `${out}/01-nginx.png`, fullPage: true });
  ok(await page.getByText("Dynamic configurations").isVisible(), "dynamic configurations card shown");
  ok(await page.getByText("Managed").first().isVisible(), "managed badge shown");

  // Expand a managed file.
  await page.getByRole("button", { name: /Main configuration/ }).click();
  await page.waitForTimeout(1500);
  ok(await page.getByText("worker_processes auto;").isVisible(), "managed file expands with content");
  await page.screenshot({ path: `${out}/02-managed-open.png`, fullPage: false });

  // Add a broken custom file: error shown, nothing saved.
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  const dlg = page.getByRole("dialog").filter({ hasText: "File name" });
  await dlg.getByPlaceholder("my-rules.conf").fill("broken.conf");
  await dlg.locator("textarea").fill("nonsense_directive on;");
  await dlg.getByRole("button", { name: "Test and apply" }).click();
  await dlg.getByText(/unknown directive/).waitFor({ timeout: 30000 });
  await page.screenshot({ path: `${out}/03-custom-error.png` });
  ok(true, "broken custom file shows the nginx error");
  // Fix it and save.
  await dlg.getByPlaceholder("my-rules.conf").fill("status.conf");
  await dlg.locator("textarea").fill('server {\n    listen 80;\n    server_name ui-status.test;\n    location / { return 200 "ui-ok"; }\n}');
  await dlg.getByRole("button", { name: "Test and apply" }).click();
  await dlg.waitFor({ state: "hidden", timeout: 30000 });
  await page.waitForTimeout(1500);
  ok(await page.getByText("status.conf", { exact: true }).isVisible(), "custom file listed after save");
  await page.screenshot({ path: `${out}/04-custom-saved.png`, fullPage: true });
  // Delete it.
  await page.getByRole("button", { name: "Delete status.conf" }).click();
  await confirmDialog(page).getByRole("button", { name: "Delete" }).click();
  await page.waitForTimeout(3000);
  ok(!(await page.getByText("status.conf", { exact: true }).isVisible()), "custom file deleted");

  // Switch to Caddy: mid-switch and after.
  await page.getByRole("button", { name: "Switch to Caddy" }).click();
  await confirmDialog(page).getByRole("button", { name: "Switch to Caddy" }).click();
  await page.getByText("Switching to Caddy…").first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/05-switching.png`, fullPage: true });
  const reloadDisabled = await page.getByRole("button", { name: "Reload" }).first().isDisabled();
  ok(reloadDisabled, "reload disabled while switching");
  ok(!(await page.getByText(/OCI runtime|No such container|is not running/).isVisible()), "no raw runtime errors while switching");
  await page.getByText("Caddy proxy").waitFor({ timeout: 120000 });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/06-caddy.png`, fullPage: true });
  ok(await page.getByText("Caddy settings").isVisible(), "caddy settings after switch");
  ok(await page.getByText("HTTP to HTTPS redirect").isVisible(), "caddy defaults include HTTPS redirect toggle");

  // Mobile.
  const mobile = await newPage(true);
  await mobile.goto(proxyUrl, { waitUntil: "networkidle", timeout: 90000 });
  await mobile.screenshot({ path: `${out}/07-caddy-mobile.png`, fullPage: true });
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok(!overflow, "no horizontal scroll at 390px");

  // None.
  await page.getByRole("button", { name: "Use no proxy" }).click();
  await confirmDialog(page).getByRole("button", { name: "Remove the proxy" }).click();
  await page.getByText("No proxy on this server").waitFor({ timeout: 120000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${out}/08-none.png`, fullPage: true });
  ok(true, "none shows the no-proxy state");

  // Back to nginx.
  await page.getByRole("button", { name: "Switch to nginx" }).click();
  await confirmDialog(page).getByRole("button", { name: "Switch to nginx" }).click();
  await page.getByText("nginx proxy").waitFor({ timeout: 120000 });
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${out}/09-nginx-again.png`, fullPage: true });
  ok(await page.getByText("Configuration test passed").isVisible(), "nginx config test passes after switching back");
}

if (serviceUrl) {
  await page.goto(base + serviceUrl, { waitUntil: "networkidle", timeout: 90000 });
  await page.getByText("Proxy config").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/10-service-managed.png`, fullPage: true });
  ok(await page.getByRole("radio", { name: /Managed by Serve/ }).isVisible(), "service proxy config card shown");
  await page.getByRole("radio", { name: /Custom/ }).click();
  await page.waitForTimeout(500);
  ok(await page.getByText(/do not apply while the configuration is custom/).isVisible(), "custom warning shown");
  await page.screenshot({ path: `${out}/11-service-custom.png`, fullPage: true });
  const mob = await newPage(true);
  await mob.goto(base + serviceUrl, { waitUntil: "networkidle", timeout: 90000 });
  await mob.screenshot({ path: `${out}/12-service-mobile.png`, fullPage: true });
  ok(!(await mob.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), "service page: no horizontal scroll at 390px");
  // Add domain dialog wording.
  await page.getByRole("button", { name: "Add domain" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/13-add-domain.png` });
}

if (page.errors.length) console.log("page errors:\n" + [...new Set(page.errors)].join("\n"));
console.log(results.join("\n"));
await browser.close();
