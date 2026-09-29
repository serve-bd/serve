import { open, base } from "./lib.mjs";
const { browser, page } = await open();
for (const s of process.argv.slice(2)) {
  await page.goto(base + s + "/domains", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Generate" }).click();
  await page.waitForTimeout(2500);
}
await browser.close();
