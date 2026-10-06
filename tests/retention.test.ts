import { describe, expect, it } from "vitest";
import { keptBackups } from "@/lib/retention";

// One backup every 6 hours for 400 days, newest first.
const now = new Date("2026-10-07T12:00:00Z");
const all = Array.from({ length: 400 * 4 }, (_, i) => ({ id: `b${i}`, createdAt: new Date(now.getTime() - i * 6 * 3_600_000) }));

describe("keptBackups", () => {
  it("keeps the newest count, and at least one", () => {
    expect([...keptBackups(all, 3, null, now)]).toEqual(["b0", "b1", "b2"]);
    expect([...keptBackups(all, 0, null, now)]).toEqual(["b0"]);
  });
  it("keeps everything younger than the days", () => {
    expect(keptBackups(all, 1, { days: 2 }, now).size).toBe(8);
  });
  it("keeps one per day, week, month and year", () => {
    const keep = keptBackups(all, 1, { daily: 7, weekly: 4, monthly: 12, yearly: 2 }, now);
    const days = new Set(
      [...keep].map((id) =>
        all
          .find((b) => b.id === id)!
          .createdAt.toISOString()
          .slice(0, 10),
      ),
    );
    // 7 days, plus older week, month and year picks; every kept backup is the newest of its day.
    expect(days.size).toBe(keep.size);
    expect(keep.size).toBeGreaterThanOrEqual(7 + 12);
    expect(keep.size).toBeLessThanOrEqual(7 + 4 + 12 + 2);
    expect(keep.has("b0")).toBe(true);
  });
});
