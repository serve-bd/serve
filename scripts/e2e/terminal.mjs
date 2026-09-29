// Opens the console of a service, types into the xterm terminal and checks the output.
// Usage: BASE=http://localhost:3001 P=<projectId> S=<serviceId> node scripts/e2e/terminal.mjs
import { chromium } from "playwright-core";
import fs from "node:fs";

const base = process.env.BASE ?? "http://localhost:3001";
const out = process.env.OUT ?? "/tmp/claude-1000";
const state = `/tmp/claude-1000/e2e-state-${new URL(base).port}.json`;
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const width = Number(process.env.WIDTH ?? 1280);
const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "dark", storageState: fs.existsSync(state) ? state : undefined });
await ctx.addInitScript(() => { window.__SERVE_E2E__ = true; });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(`${base}/projects/${process.env.P}/services/${process.env.S}/console`, { waitUntil: "networkidle" });
await page.waitForSelector(".xterm-screen", { timeout: 30000 });
const rows = () => page.evaluate(() => [...document.querySelectorAll(".xterm-rows > div")].map((d) => d.textContent).join("\n"));
const waitFor = async (re, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const text = await rows();
    if (re.test(text)) return text;
    await page.waitForTimeout(200);
  }
  throw new Error(`Timed out waiting for ${re}. Screen:\n${await rows()}`);
};
await waitFor(/[#$]\s*$/m);
await page.keyboard.type("echo hello-$((6*7)) && stty size\n");
const text = await waitFor(/hello-42/);
console.log("echo ok; size:", text.match(/hello-42\s*\n\s*(\d+ \d+)/)?.[1]);
if (process.env.PSQL) {
  await page.keyboard.type("psql -c 'select 1+1 as two'\n");
  await waitFor(/two\s*[\s\S]*\b2\b/);
  console.log("psql ok");
}
// Interactive program: Ctrl-C interrupts it.
await page.keyboard.type("sleep 30\n");
await page.waitForTimeout(500);
await page.keyboard.press("Control+C");
await page.keyboard.type("echo after-$((1+1))\n");
await waitFor(/after-2/);
console.log("ctrl-c ok");
await page.screenshot({ path: `${out}/terminal-${width}.png` });
await page.keyboard.type("exit\n");
await page.getByText("Start a new session").waitFor({ timeout: 10000 });
console.log("exit ok");
if (errors.length) console.log("errors:", errors);
await browser.close();
