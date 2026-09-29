import { chromium } from "playwright-core";
export const base = process.env.BASE ?? "http://localhost:3001";
const state = `/tmp/claude-1000/e2e-state-${new URL(base).port}.json`;

export async function open() {
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: state });
  await ctx.addInitScript(() => {
    window.__SERVE_E2E__ = true;
  });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("serve-theme", "light");
    } catch {}
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  return { browser, page };
}

export async function firstProject(page) {
  await page.goto(base + "/projects", { waitUntil: "networkidle" });
  await page.locator('a[href^="/projects/"]:not([href="/projects/new"])').first().click();
  await page.waitForURL(/\/projects\/[a-z0-9]+$/);
  return page.url();
}

export async function waitStatus(page, re = /Running|Failed|Crashed/, timeout = 300000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const status =
      (await page
        .locator("header")
        .getByText(/^(Running|Failed|Crashed|Deploying|Building|Not deployed|Restarting|Stopped)$/)
        .first()
        .textContent()
        .catch(() => "")) ?? "";
    if (re.test(status)) return status;
    await page.waitForTimeout(1500);
  }
  return "timeout";
}

export async function toastText(page) {
  return (await page.locator(".toast").allInnerTexts()).join(" | ");
}
