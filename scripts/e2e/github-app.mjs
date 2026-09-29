// Checks the GitHub App manifest form and the error path of the callback.
import { base, open } from "./lib.mjs";
const { browser, page } = await open();
await page.goto(base + "/integrations/git", { waitUntil: "networkidle" });
const request = page.waitForRequest((r) => r.url().startsWith("https://github.com/settings/apps/new"), { timeout: 15000 });
await page.route("https://github.com/**", (route) => route.fulfill({ status: 200, body: "stub" }));
await page.getByRole("button", { name: "Continue on GitHub" }).click();
const req = await request;
const manifest = JSON.parse(new URLSearchParams(req.postData()).get("manifest"));
const state = new URL(req.url()).searchParams.get("state");
console.log("method:", req.method(), "| has state:", !!state);
console.log("hook:", manifest.hook_attributes.url);
console.log("redirect:", manifest.redirect_url, "| events:", manifest.default_events.join(","), "| perms:", JSON.stringify(manifest.default_permissions));
// Tampered state is rejected.
await page.unroute("https://github.com/**");
await page.goto(`${base}/api/github/manifest?code=abc&state=${state.slice(0, -3)}xyz`);
await page.waitForLoadState("networkidle");
console.log("forged state ->", decodeURIComponent(page.url().replace(base, "")));
await page.screenshot({ path: "/tmp/claude-1000/gh-error.png" });
await browser.close();
