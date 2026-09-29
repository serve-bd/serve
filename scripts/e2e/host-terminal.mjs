// Opens /server/terminal, runs read-only commands on the host and checks the output.
// Usage: BASE=http://localhost:3001 node scripts/e2e/host-terminal.mjs
import { chromium } from "playwright-core";
import fs from "node:fs";

const base = process.env.BASE ?? "http://localhost:3001";
const state = `/tmp/claude-1000/e2e-state-${new URL(base).port}.json`;
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark", storageState: fs.existsSync(state) ? state : undefined });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`${base}/server/terminal`, { waitUntil: "load", timeout: 90000 });
await page.waitForSelector(".xterm-screen", { timeout: 60000 });
const rows = () => page.evaluate(() => [...document.querySelectorAll(".xterm-rows > div")].map((d) => d.textContent).join("\n"));
const waitFor = async (re, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const text = await rows();
    if (re.test(text)) return text;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for ${re}. Screen:\n${await rows()}`);
};
await waitFor(/[#$]\s*$/m);
await page.keyboard.type("echo H=$(hostname) U=$(id -u); head -2 /etc/os-release\n");
const text = await waitFor(/H=\S+ U=\d+/);
console.log(text.match(/H=\S+ U=\d+/)[0]);
await page.keyboard.type("exit\n");
await page.getByText("Start a new session").waitFor({ timeout: 15000 });
console.log("exit ok");
if (errors.length) console.log("errors:", errors);
await browser.close();
