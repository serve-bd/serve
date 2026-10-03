import { describe, expect, it } from "vitest";
import { type DeployRules, freezeState, needsApproval } from "@/lib/deploy-rules";

// 2026-10-02 is a Friday.
const at = (iso: string) => new Date(iso);

describe("freezeState", () => {
  const weekend: DeployRules = {
    freeze: {
      windows: [
        { days: [5], start: "18:00", end: "09:00" },
        { days: [6, 0], start: "00:00", end: "00:00" },
      ],
      timezone: "UTC",
    },
  };

  it("is frozen inside a weekly window and says until when", () => {
    const s = freezeState(weekend, "env", at("2026-10-02T19:00:00Z"));
    expect(s.frozen).toBe(true);
    // Friday 18:00 runs past midnight into Saturday, which is frozen all day, then Sunday: open Monday.
    if (s.frozen) expect(s.until?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });

  it("is open outside the windows", () => {
    expect(freezeState(weekend, "env", at("2026-10-02T12:00:00Z")).frozen).toBe(false);
    expect(freezeState(weekend, "env", at("2026-10-05T10:00:00Z")).frozen).toBe(false);
  });

  it("covers the early hours after a window that runs past midnight", () => {
    const night: DeployRules = { freeze: { windows: [{ days: [1], start: "22:00", end: "06:00" }], timezone: "UTC" } };
    // Tuesday 03:00 is still Monday night's window.
    expect(freezeState(night, "env", at("2026-10-06T03:00:00Z")).frozen).toBe(true);
    expect(freezeState(night, "env", at("2026-10-06T07:00:00Z")).frozen).toBe(false);
  });

  it("reads the windows in their time zone", () => {
    const dhaka: DeployRules = { freeze: { windows: [{ days: [5], start: "18:00", end: "20:00" }], timezone: "Asia/Dhaka" } };
    // 12:30 UTC is 18:30 in Dhaka.
    expect(freezeState(dhaka, "env", at("2026-10-02T12:30:00Z")).frozen).toBe(true);
    expect(freezeState(dhaka, "env", at("2026-10-02T18:30:00Z")).frozen).toBe(false);
  });

  it("freezes now until turned off or until its end", () => {
    const now: DeployRules = { freeze: { now: { since: "2026-10-01T00:00:00Z", reason: "Sale" } } };
    const s = freezeState(now, "env", at("2026-10-02T12:00:00Z"));
    expect(s).toEqual({ frozen: true, until: null, reason: "Sale", manual: true });
    const ended: DeployRules = { freeze: { now: { since: "2026-10-01T00:00:00Z", until: "2026-10-02T00:00:00Z" } } };
    expect(freezeState(ended, "env", at("2026-10-02T12:00:00Z")).frozen).toBe(false);
  });

  it("applies only to the picked environments", () => {
    const prod: DeployRules = { freeze: { now: { since: "2026-10-01T00:00:00Z" }, environmentIds: ["prod"] } };
    expect(freezeState(prod, "prod").frozen).toBe(true);
    expect(freezeState(prod, "staging").frozen).toBe(false);
  });
});

describe("needsApproval", () => {
  it("follows the switch and the environments", () => {
    expect(needsApproval({ approval: { enabled: true } }, "any")).toBe(true);
    expect(needsApproval({ approval: { enabled: false } }, "any")).toBe(false);
    expect(needsApproval({ approval: { enabled: true, environmentIds: ["prod"] } }, "staging")).toBe(false);
    expect(needsApproval(null, "any")).toBe(false);
  });
});
