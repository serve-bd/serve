import { describe, expect, it } from "vitest";

describe("requestIsHttps", async () => {
  const { requestIsHttps } = await import("@/lib/request-https");
  it("follows the proxy's X-Forwarded-Proto and treats a direct request as plain HTTP", () => {
    expect(requestIsHttps(new Headers({ "x-forwarded-proto": "https" }))).toBe(true);
    expect(requestIsHttps(new Headers({ "x-forwarded-proto": "HTTPS, http" }))).toBe(true);
    expect(requestIsHttps(new Headers({ "x-forwarded-proto": "http" }))).toBe(false);
    expect(requestIsHttps(new Headers())).toBe(false);
    expect(requestIsHttps(null)).toBe(false);
  });
});
