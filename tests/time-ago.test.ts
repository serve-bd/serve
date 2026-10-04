import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { timeAgo } from "@/lib/utils";

describe("timeAgo", () => {
  const now = new Date("2026-10-05T12:00:00Z").getTime();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it("says how long ago a past date was", () => {
    expect(timeAgo(now - 2_000)).toBe("just now");
    expect(timeAgo(now - 30_000)).toBe("30s ago");
    expect(timeAgo(now - 5 * 60_000)).toBe("5m ago");
    expect(timeAgo(now - 3 * 3_600_000)).toBe("3h ago");
    expect(timeAgo(now - 2 * 86_400_000)).toBe("2d ago");
    expect(timeAgo(now - (2 * 86_400_000 - 60_000))).toBe("1d ago");
  });

  it("says how long until a date still to come, instead of 'just now'", () => {
    expect(timeAgo(now + 2_000)).toBe("just now");
    expect(timeAgo(now + 30_000)).toBe("in 30s");
    expect(timeAgo(now + 5 * 60_000)).toBe("in 5m");
    expect(timeAgo(now + 3 * 3_600_000)).toBe("in 3h");
    expect(timeAgo(now + 7 * 86_400_000)).toBe("in 7d");
    // made a moment ago for 7 days
    expect(timeAgo(now + 7 * 86_400_000 - 30_000)).toBe("in 7d");
  });
});
