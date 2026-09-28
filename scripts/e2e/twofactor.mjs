// Enables 2FA for a fresh user, signs in with a TOTP code, then disables it.
import { chromium } from "playwright-core";
import crypto from "node:crypto";
const base = process.env.BASE ?? "http://localhost:3001";
const email = "owner@serve.test", password = "owner-pass-123";
function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.replace(/=+$/, "")) bits += alphabet.indexOf(c.toUpperCase()).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, "0");
}
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ storageState: `/tmp/claude-1000/e2e-state-${new URL(base).port}.json` });
const page = await ctx.newPage();
await page.goto(base + "/account", { waitUntil: "networkidle" });
const enableRes = page.waitForResponse((r) => r.url().includes("/two-factor/enable"));
await page.getByRole("button", { name: "Enable" }).click();
await page.locator('[role="dialog"] input[type="password"]').fill(password);
await page.getByRole("button", { name: "Continue" }).click();
const { totpURI } = await (await enableRes).json();
const secret = new URL(totpURI).searchParams.get("secret");
await page.locator('[role="dialog"] input[inputmode="numeric"]').fill(totp(secret));
await page.getByRole("button", { name: "Verify and enable" }).click();
await page.waitForTimeout(1500);
console.log("enabled:", await page.getByText("Enabled", { exact: true }).count() > 0);
// Fresh login requires the code.
const ctx2 = await browser.newContext();
const p2 = await ctx2.newPage();
await p2.goto(base + "/login", { waitUntil: "networkidle" });
await p2.fill('input[name="email"]', email);
await p2.fill('input[name="password"]', password);
await p2.click('button[type="submit"]');
await p2.getByText("Two-factor authentication").waitFor();
await p2.fill('input[name="code"]', totp(secret));
await p2.getByRole("button", { name: "Verify" }).click();
await p2.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
console.log("login with code ok:", p2.url());
// Disable again.
await page.reload({ waitUntil: "networkidle" });
await page.getByRole("button", { name: "Disable" }).click();
await page.locator('[role="dialog"] input[type="password"]').fill(password);
await page.locator('[role="dialog"]').getByRole("button", { name: "Disable" }).click();
await page.waitForTimeout(1500);
console.log("disabled:", await page.getByText("Not enabled").count() > 0);
await browser.close();
