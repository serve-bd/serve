import { beforeEach, describe, expect, it } from "vitest";
import { resetRateLimits, takeRequest } from "@/server/api/rate-limit";

describe("API rate limit", () => {
  beforeEach(() => resetRateLimits());

  it("allows the limit per minute per token, then answers with Retry-After", () => {
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 3; i++) expect(takeRequest("tok", 3, t0 + i).allowed).toBe(true);
    const over = takeRequest("tok", 3, t0 + 10_000);
    expect(over.allowed).toBe(false);
    expect(over.headers["x-ratelimit-remaining"]).toBe("0");
    expect(over.headers["retry-after"]).toBe("50");
    // Another token has its own window.
    expect(takeRequest("other", 3, t0 + 10_000).allowed).toBe(true);
    // A new minute starts over.
    expect(takeRequest("tok", 3, t0 + 60_000).allowed).toBe(true);
  });

  it("does nothing with no limit", () => {
    const r = takeRequest("tok", 0);
    expect(r).toEqual({ allowed: true, headers: {} });
  });
});
