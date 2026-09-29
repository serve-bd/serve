import { chromium } from "playwright-core";
const base = process.env.BASE ?? "http://localhost:3001";
const theme = process.env.THEME ?? "dark";
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: `/tmp/claude-1000/e2e-state-${new URL(base).port}.json` });
await ctx.addInitScript(() => {
  window.__SERVE_E2E__ = true;
});
await ctx.addInitScript((t) => {
  try {
    localStorage.setItem("serve-theme", t);
  } catch {}
}, theme);
const page = await ctx.newPage();
const P = "/projects/qo54wmtde6yvi0j5",
  S = `${P}/services/tde4j8emy0w92qi7`;
const shot = async (n) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `/tmp/claude-1000/dlg-${n}-${theme}.png` });
};

await page.goto(base + P + "/new?type=git", { waitUntil: "networkidle" });
await shot("git");
await page.goto(base + S + "/domains", { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Add domain" }).click();
await page.getByPlaceholder("app.example.com").fill("shop.example.com");
await shot("domain");
await page.keyboard.press("Escape");
await page.goto(base + "/certificates", { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Add certificate" }).click();
await shot("cert");
await page.keyboard.press("Escape");
await page.goto(base + "/", { waitUntil: "networkidle" });
await page.keyboard.press("Control+k");
await page.keyboard.type("node");
await shot("palette");
await page.keyboard.press("Escape");
await page.getByRole("button", { name: /Root/ }).first().click();
await shot("orgmenu");
await browser.close();
