import { describe, expect, it } from "vitest";
import { crashesInARow, STABLE_MS } from "@/server/monitoring/crash-count";
import { crashLimitOf, DEFAULT_CRASH_LIMIT } from "@/server/services/types";

describe("crash limit", () => {
  it("applies only to policies that restart forever", () => {
    expect(crashLimitOf({ restartPolicy: "unless-stopped" })).toBe(DEFAULT_CRASH_LIMIT);
    expect(crashLimitOf({ restartPolicy: "always", crashLimit: 3 })).toBe(3);
    expect(crashLimitOf({ restartPolicy: "always", crashLimit: null })).toBeNull();
    expect(crashLimitOf({ restartPolicy: "on-failure", crashLimit: 3 })).toBeNull();
    expect(crashLimitOf({ restartPolicy: "no" })).toBeNull();
  });

  it("counts restarts in a row and starts over after a stable run", () => {
    const now = 1_000_000_000;
    let r = crashesInARow(undefined, { restartCount: 4, running: false, startedAt: now - 1000, createdAt: now - 5000 }, now, now - 60_000);
    expect(r.crashes).toBe(4);
    // Up for longer than STABLE_MS: earlier crashes no longer count.
    r = crashesInARow(r.track, { restartCount: 4, running: true, startedAt: now - STABLE_MS, createdAt: now - 5000 }, now);
    expect(r.crashes).toBe(0);
    r = crashesInARow(r.track, { restartCount: 6, running: false, startedAt: now, createdAt: now - 5000 }, now);
    expect(r.crashes).toBe(2);
  });

  it("starts over when Docker resets the count", () => {
    const now = 1_000_000_000;
    const r = crashesInARow({ base: 8 }, { restartCount: 1, running: false, startedAt: now, createdAt: now }, now);
    expect(r.crashes).toBe(1);
  });

  it("does not count restarts from before the worker started watching", () => {
    const now = 1_000_000_000;
    const day = 86_400_000;
    // Restarted 14 times over two weeks, then the worker restarted: nothing counts yet.
    let r = crashesInARow(undefined, { restartCount: 14, running: true, startedAt: now - 60_000, createdAt: now - 14 * day }, now, now - 30_000);
    expect(r.crashes).toBe(0);
    r = crashesInARow(r.track, { restartCount: 15, running: false, startedAt: now, createdAt: now - 14 * day }, now, now - 30_000);
    expect(r.crashes).toBe(1);
  });
});
