import { describe, expect, it } from "vitest";
import { crossSiteRequest } from "@/lib/same-origin";

const req = (method: string, headers: Record<string, string>) => new Request("http://localhost:3000/api/services/s1/exec", { method, headers });

describe("cross-site check", () => {
  it("lets reads through", () => {
    expect(crossSiteRequest(req("GET", { origin: "https://evil.example", "sec-fetch-site": "cross-site" }))).toBe(false);
  });
  it("refuses a post from another site", () => {
    expect(crossSiteRequest(req("POST", { host: "dash.example.com", "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(crossSiteRequest(req("POST", { host: "dash.example.com", "sec-fetch-site": "same-site" }))).toBe(true);
    expect(crossSiteRequest(req("POST", { host: "dash.example.com", origin: "https://evil.example" }))).toBe(true);
    expect(crossSiteRequest(req("POST", { host: "dash.example.com", origin: "null" }))).toBe(true);
  });
  it("accepts the dashboard's own pages", () => {
    expect(crossSiteRequest(req("POST", { host: "dash.example.com", origin: "https://dash.example.com", "sec-fetch-site": "same-origin" }))).toBe(false);
    // Through a tunnel or proxy that forwards the address the browser used.
    expect(crossSiteRequest(req("POST", { host: "serve:3000", "x-forwarded-host": "dash.example.com", origin: "https://dash.example.com" }))).toBe(false);
    expect(crossSiteRequest(req("POST", { host: "serve:3000", origin: "http://203.0.113.5:8000" }), "http://203.0.113.5:8000")).toBe(false);
    expect(crossSiteRequest(req("POST", { host: "Dash.Example.com:443", origin: "https://dash.example.com" }))).toBe(false);
  });
  it("accepts clients that are not browsers", () => {
    expect(crossSiteRequest(req("POST", { host: "dash.example.com" }))).toBe(false);
  });
});
