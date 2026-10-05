import { describe, expect, it } from "vitest";
import { cleanCss, cleanUrl, componentLevel, dayLevel, maintenancePhase, type NoticeFacts, noticeActive, slugify, slugPattern, worst } from "@/lib/status-page";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const at = (h: number) => new Date(NOW + h * 3600_000).toISOString();
const notice = (n: Partial<NoticeFacts>): NoticeFacts => ({ kind: "incident", impact: "major", componentIds: ["c1"], startsAt: at(-1), endsAt: null, resolvedAt: null, ...n });

describe("status levels", () => {
  it("takes the worst level and ignores unknown", () => {
    expect(worst(["operational", "degraded", "unknown"])).toBe("degraded");
    expect(worst(["unknown"])).toBe("unknown");
    expect(worst(["maintenance", "operational"])).toBe("maintenance");
    expect(worst(["partial", "major", "degraded"])).toBe("major");
  });

  it("follows the check without notices", () => {
    expect(componentLevel({ componentId: "c1", check: "up", notices: [], now: NOW })).toBe("operational");
    expect(componentLevel({ componentId: "c1", check: "down", notices: [], now: NOW })).toBe("major");
    expect(componentLevel({ componentId: "c1", check: "pending", notices: [], now: NOW })).toBe("unknown");
    // No check at all: fine until someone posts otherwise.
    expect(componentLevel({ componentId: "c1", check: null, notices: [], now: NOW })).toBe("operational");
  });

  it("an open incident sets at least its impact, only for its components", () => {
    const minor = notice({ impact: "minor" });
    expect(componentLevel({ componentId: "c1", check: "up", notices: [minor], now: NOW })).toBe("degraded");
    expect(componentLevel({ componentId: "c2", check: "up", notices: [minor], now: NOW })).toBe("operational");
    expect(componentLevel({ componentId: "c1", check: null, notices: [notice({ impact: "critical" })], now: NOW })).toBe("major");
    // A failing check stays worse than a minor post.
    expect(componentLevel({ componentId: "c1", check: "down", notices: [minor], now: NOW })).toBe("major");
    expect(componentLevel({ componentId: "c1", check: "up", notices: [notice({ resolvedAt: at(-0.5) })], now: NOW })).toBe("operational");
  });

  it("maintenance in its window wins over a failing check, and not before or after", () => {
    const window = notice({ kind: "maintenance", startsAt: at(-1), endsAt: at(1) });
    expect(componentLevel({ componentId: "c1", check: "down", notices: [window], now: NOW })).toBe("maintenance");
    const later = notice({ kind: "maintenance", startsAt: at(2), endsAt: at(3) });
    expect(componentLevel({ componentId: "c1", check: "up", notices: [later], now: NOW })).toBe("operational");
    const over = notice({ kind: "maintenance", startsAt: at(-3), endsAt: at(-2) });
    expect(componentLevel({ componentId: "c1", check: "down", notices: [over], now: NOW })).toBe("major");
  });

  it("maintenance phases go by time unless completed early", () => {
    expect(maintenancePhase({ startsAt: at(1), endsAt: at(2), resolvedAt: null }, NOW)).toBe("scheduled");
    expect(maintenancePhase({ startsAt: at(-1), endsAt: at(1), resolvedAt: null }, NOW)).toBe("in-progress");
    expect(maintenancePhase({ startsAt: at(-2), endsAt: at(-1), resolvedAt: null }, NOW)).toBe("completed");
    expect(maintenancePhase({ startsAt: at(-1), endsAt: at(1), resolvedAt: at(-0.5) }, NOW)).toBe("completed");
    expect(noticeActive(notice({ kind: "maintenance", startsAt: at(-1), endsAt: at(1) }), NOW)).toBe(true);
  });

  it("colors a day by uptime, made worse by posted incidents", () => {
    expect(dayLevel(100, [])).toBe("operational");
    expect(dayLevel(99.5, [])).toBe("degraded");
    expect(dayLevel(80, [])).toBe("major");
    expect(dayLevel(null, [])).toBe("unknown");
    expect(dayLevel(100, ["major"])).toBe("partial");
    expect(dayLevel(null, ["minor"])).toBe("degraded");
  });
});

describe("status page input", () => {
  it("makes slugs from names", () => {
    expect(slugify("Acme Cloud")).toBe("acme-cloud");
    expect(slugify("  Café — Status!! ")).toBe("cafe-status");
    expect(slugPattern.test("acme-cloud")).toBe(true);
    expect(slugPattern.test("-acme")).toBe(false);
    expect(slugPattern.test("Acme")).toBe(false);
  });

  it("keeps custom CSS inside its style element", () => {
    expect(cleanCss(".sp{color:red}</style><script>alert(1)</script>")).not.toMatch(/<\/style/i);
    expect(cleanCss("   ")).toBeNull();
  });

  it("allows only web and mail links", () => {
    expect(cleanUrl("acme.com/help")).toBe("https://acme.com/help");
    expect(cleanUrl("mailto:help@acme.com")).toBe("mailto:help@acme.com");
    expect(cleanUrl("javascript:alert(1)")).toBeNull();
    expect(cleanUrl("data:text/html,hi")).toBeNull();
    expect(cleanUrl("")).toBeNull();
  });
});
