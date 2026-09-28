import { base, open } from "./lib.mjs";
const svc = process.argv[2];
const { browser, page } = await open();
await page.goto(base + svc + "/backups", { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Back up now" }).click();
await page.waitForTimeout(5000);
await browser.close();
