// Joins servers to the private network through the UI and waits until they see each other.
// Usage: OUT=<dir> node scripts/e2e/mesh.mjs <serverId>=<endpoint> [<serverId>=<endpoint> ...]
import { chromium } from "playwright-core";

const base = process.env.BASE ?? "http://localhost:3001";
const out = process.env.OUT ?? "/tmp/claude-1000";
const pairs = process.argv.slice(2).map((a) => a.split("="));
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: "dark", storageState: `/tmp/claude-1000/e2e-state-${new URL(base).port}.json` });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

for (const [id, endpoint] of pairs) {
  await page.goto(`${base}/servers/${id}/network`, { waitUntil: "networkidle" });
  const join = page.getByRole("button", { name: "Join private network" });
  if (await join.isVisible().catch(() => false)) {
    await page.screenshot({ path: `${out}/mesh-join-${id}.png`, fullPage: true });
    // A detected address is picked from the list; anything else goes in "Another address".
    const detected = page.getByRole("radio", { name: new RegExp(`^${endpoint.replaceAll(".", "\\.")}\\b`) });
    if (await detected.isVisible().catch(() => false)) await detected.click();
    else {
      const other = page.getByRole("radio", { name: /Another address/ });
      if (await other.isVisible().catch(() => false)) await other.click();
      await page.getByRole("textbox", { name: "Address" }).fill(endpoint);
    }
    await join.click();
    await page.getByText("Private address", { exact: true }).waitFor({ timeout: 15000 });
    console.log(`${id}: joined with ${endpoint}`);
  } else console.log(`${id}: already joined`);
}

// Every server should show every other one as connected.
for (const [id] of pairs) {
  await page.goto(`${base}/servers/${id}/network`, { waitUntil: "networkidle" });
  const want = pairs.length - 1;
  const started = Date.now();
  let connected = 0;
  while (Date.now() - started < 180000) {
    connected = await page.getByText("Connected", { exact: true }).count();
    if (connected >= want && (await page.getByText("On", { exact: true }).count())) break;
    await page.waitForTimeout(2000);
  }
  await page.screenshot({ path: `${out}/mesh-${id}.png`, fullPage: true });
  console.log(`${id}: ${connected}/${want} connected`);
}
if (errors.length) console.log("page errors:", errors);
await browser.close();
