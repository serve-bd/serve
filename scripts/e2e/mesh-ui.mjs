// Private network UI flows: change a server's port with Edit, then Leave and join again.
// Usage: OUT=<dir> node scripts/e2e/mesh-ui.mjs <serverId> <otherServerId>
import { chromium } from "playwright-core";

const base = process.env.BASE ?? "http://localhost:3001";
const out = process.env.OUT ?? "/tmp/claude-1000";
const [id, other] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: "dark", storageState: `/tmp/claude-1000/e2e-state-${new URL(base).port}.json` });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const connectedOn = async (serverId, want = 1) => {
  await page.goto(`${base}/servers/${serverId}/network`, { waitUntil: "networkidle" });
  const started = Date.now();
  while (Date.now() - started < 120000) {
    if ((await page.getByText("Connected", { exact: true }).count()) >= want) return true;
    await page.waitForTimeout(2000);
  }
  return false;
};

// Edit: move WireGuard to another port; the other servers follow.
await page.goto(`${base}/servers/${id}/network`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Edit" }).click();
const port = page.getByLabel("UDP port");
await port.click();
await port.fill("51821");
await page.getByRole("button", { name: "Save", exact: true }).click();
await page.getByText("Private address", { exact: true }).waitFor({ timeout: 15000 });
console.log("edit: saved port 51821");
console.log("edit: peer reconnected on the other server:", await connectedOn(other));
console.log(
  "edit: reached at shows the new port:",
  await page
    .getByText(/:51821/)
    .first()
    .isVisible(),
);

// Leave, confirm, and join again.
await page.goto(`${base}/servers/${id}/network`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Leave" }).click();
await page.getByRole("button", { name: "Leave network" }).click();
await page.getByRole("button", { name: "Join private network" }).waitFor({ timeout: 20000 });
await page.screenshot({ path: `${out}/mesh-ui-left.png`, fullPage: true });
console.log("leave: join form is back");
await page.goto(`${base}/servers/${other}/network`, { waitUntil: "networkidle" });
await page.waitForTimeout(8000);
await page.reload({ waitUntil: "networkidle" });
console.log("leave: the other server no longer lists it:", !(await page.getByRole("link", { name: /e2e-remote-2$/ }).count()));
await page.goto(`${base}/servers/${id}/network`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Join private network" }).click();
await page.getByText("Private address", { exact: true }).waitFor({ timeout: 15000 });
console.log("join again: reconnected:", await connectedOn(id));
await page.screenshot({ path: `${out}/mesh-ui-rejoined.png`, fullPage: true });
if (errors.length) console.log("page errors:", errors);
await browser.close();
