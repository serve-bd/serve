import { describe, expect, it } from "vitest";
import { alertActive, dailyBars, isCrashLooping, nextMonitorState, parseExpectedStatus, uptimePercent } from "@/server/monitoring/state";

describe("nextMonitorState", () => {
  it("goes down only after the failure threshold", () => {
    let s = { status: "up" as const, consecutiveFailures: 0 } as ReturnType<typeof nextMonitorState>;
    s = nextMonitorState(s, false, 3);
    expect(s).toMatchObject({ status: "up", consecutiveFailures: 1, transition: null });
    s = nextMonitorState(s, false, 3);
    expect(s).toMatchObject({ status: "up", consecutiveFailures: 2, transition: null });
    s = nextMonitorState(s, false, 3);
    expect(s).toMatchObject({ status: "down", consecutiveFailures: 3, transition: "down" });
  });

  it("reports down once, then stays down quietly", () => {
    const down = nextMonitorState({ status: "down", consecutiveFailures: 3 }, false, 3);
    expect(down).toMatchObject({ status: "down", transition: null, consecutiveFailures: 4 });
  });

  it("recovers on the first success", () => {
    expect(nextMonitorState({ status: "down", consecutiveFailures: 7 }, true, 3)).toMatchObject({ status: "up", consecutiveFailures: 0, transition: "recovered" });
  });

  it("a first success is not a recovery", () => {
    expect(nextMonitorState({ status: "pending", consecutiveFailures: 0 }, true, 3).transition).toBeNull();
  });

  it("pending stays pending until the threshold, and a threshold of 1 fails at once", () => {
    expect(nextMonitorState({ status: "pending", consecutiveFailures: 0 }, false, 2)).toMatchObject({ status: "pending", transition: null });
    expect(nextMonitorState({ status: "pending", consecutiveFailures: 0 }, false, 1)).toMatchObject({ status: "down", transition: "down" });
  });
});

describe("parseExpectedStatus", () => {
  it("accepts ranges, lists and classes", () => {
    const f = parseExpectedStatus("200-299, 301, 4xx")!;
    expect([200, 250, 299, 301, 404].every(f)).toBe(true);
    expect([300, 302, 500].some(f)).toBe(false);
  });
  it("rejects invalid specs", () => {
    for (const s of ["", "abc", "300-200", "20", "6xx"]) expect(parseExpectedStatus(s), s).toBeNull();
  });
});

describe("rollups", () => {
  const today = new Date("2026-03-10T12:00:00Z");
  it("has one bar per day, oldest first, with gaps as null", () => {
    const bars = dailyBars(
      [
        { day: "2026-03-10", checks: 100, failures: 1 },
        { day: "2026-03-08", checks: 10, failures: 0 },
      ],
      3,
      today,
    );
    expect(bars.map((b) => b.day)).toEqual(["2026-03-08", "2026-03-09", "2026-03-10"]);
    expect(bars.map((b) => b.uptime)).toEqual([100, null, 99]);
  });
  it("uptime is weighted by the number of checks", () => {
    expect(
      uptimePercent([
        { checks: 90, failures: 0 },
        { checks: 10, failures: 10 },
      ]),
    ).toBe(90);
    expect(uptimePercent([])).toBeNull();
  });
});

describe("alertActive", () => {
  it("uses hysteresis so values at the line do not flap", () => {
    expect(alertActive(84, 85, false)).toBe(false);
    expect(alertActive(85, 85, false)).toBe(true);
    expect(alertActive(82, 85, true)).toBe(true);
    expect(alertActive(79, 85, true)).toBe(false);
  });
});

describe("isCrashLooping", () => {
  const now = 1_000_000_000;
  it("flags three restarts within the window", () => {
    const samples = [
      { at: now - 5 * 60_000, restartCount: 2 },
      { at: now - 2 * 60_000, restartCount: 4 },
      { at: now, restartCount: 5 },
    ];
    expect(isCrashLooping(samples, now)).toBe(true);
  });
  it("ignores old restarts and single samples", () => {
    expect(
      isCrashLooping(
        [
          { at: now - 30 * 60_000, restartCount: 0 },
          { at: now, restartCount: 10 },
        ],
        now,
      ),
    ).toBe(false);
    expect(isCrashLooping([{ at: now, restartCount: 10 }], now)).toBe(false);
    expect(
      isCrashLooping(
        [
          { at: now - 60_000, restartCount: 3 },
          { at: now, restartCount: 4 },
        ],
        now,
      ),
    ).toBe(false);
  });
});
