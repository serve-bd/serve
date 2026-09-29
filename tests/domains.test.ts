import { describe, expect, it } from "vitest";
import { pickPrimaryDomain } from "@/lib/domains";

const d = (hostname: string, o: { generated?: boolean; primary?: boolean; redirectTo?: string | null; createdAt?: string } = {}) => ({
  hostname,
  generated: o.generated ?? false,
  primary: o.primary ?? false,
  redirectTo: o.redirectTo ?? null,
  createdAt: o.createdAt ?? "2026-01-01T00:00:00Z",
});

describe("pickPrimaryDomain", () => {
  it("prefers the chosen primary", () => {
    expect(pickPrimaryDomain([d("a.com"), d("x.sslip.io", { generated: true, primary: true })])?.hostname).toBe("x.sslip.io");
  });
  it("falls back to the oldest custom domain, then generated", () => {
    const list = [d("x.sslip.io", { generated: true, createdAt: "2025-01-01T00:00:00Z" }), d("b.com", { createdAt: "2026-02-01T00:00:00Z" }), d("a.com", { createdAt: "2026-01-01T00:00:00Z" })];
    expect(pickPrimaryDomain(list)?.hostname).toBe("a.com");
    expect(pickPrimaryDomain([list[0]])?.hostname).toBe("x.sslip.io");
  });
  it("never picks a redirect", () => {
    expect(pickPrimaryDomain([d("www.a.com", { redirectTo: "https://a.com", primary: true })])).toBeNull();
  });
});
