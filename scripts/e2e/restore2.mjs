import { base, open } from "./lib.mjs";
const svc = process.argv[2];
const { browser, page } = await open();
await page.goto(base + svc + "/backups", { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Backup actions" }).first().click();
await page.getByRole("menuitem", { name: "Restore" }).click();
await page.getByRole("button", { name: "Restore" }).click();
await page.waitForTimeout(6000);
await browser.close();
