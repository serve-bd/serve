import { describe, expect, it } from "vitest";
import { hostDashboardUrl, serverCliPlan, serverCliTokens } from "@/lib/server-cli";

describe("cli.json token: keep or make a new one", () => {
  const now = Date.parse("2026-10-04T00:00:00Z");
  const token = (userId: string, expiresAt: Date | null = null) => ({ id: "t1", userId, expiresAt });

  it("keeps a token whose owner is still an admin", () => {
    expect(serverCliPlan(token("a"), ["b", "a"], now)).toEqual({ action: "keep", tokenId: "t1" });
    expect(serverCliPlan(token("a", new Date(now + 1000)), ["a"], now)).toEqual({ action: "keep", tokenId: "t1" });
  });

  it("makes a new one for the oldest admin when the token is gone, expired or its owner lost admin", () => {
    expect(serverCliPlan(null, ["first", "second"], now)).toEqual({ action: "create", userId: "first" });
    expect(serverCliPlan(token("a", new Date(now - 1)), ["a"], now)).toEqual({ action: "create", userId: "a" });
    expect(serverCliPlan(token("removed"), ["b"], now)).toEqual({ action: "create", userId: "b" });
  });

  it("writes nothing while there is no admin", () => {
    expect(serverCliPlan(null, [], now)).toEqual({ action: "none" });
    expect(serverCliPlan(token("a"), [], now)).toEqual({ action: "none" });
  });
});

describe("the dashboard address for the CLI on the host", () => {
  it("uses the published dashboard port of the container setup", () => {
    expect(hostDashboardUrl({ SERVE_DASHBOARD_PORT: "8000", SERVE_ROLE: "worker" }, "https://dash.example.com")).toBe("http://127.0.0.1:8000");
  });

  it("uses the local app URL in development", () => {
    expect(hostDashboardUrl({ BETTER_AUTH_URL: "http://localhost:3000/" }, "https://s.example.com")).toBe("http://localhost:3000");
    expect(hostDashboardUrl({ BETTER_AUTH_URL: "https://dash.example.com", PORT: "3100" }, null)).toBe("http://localhost:3100");
    expect(hostDashboardUrl({}, null)).toBe("http://localhost:3000");
  });

  it("falls back to the public address in a container without a known port", () => {
    expect(hostDashboardUrl({ SERVE_ROLE: "worker" }, "https://dash.example.com")).toBe("https://dash.example.com");
    expect(hostDashboardUrl({ SERVE_ROLE: "worker", SERVE_DASHBOARD_PORT: "abc" }, null)).toBe("http://127.0.0.1:3000");
  });
});

describe("which token cli.json may keep", () => {
  const row = (id: string) => ({ id, userId: "u", expiresAt: null });

  it("keeps the stored token while the file holds it", () => {
    expect(serverCliTokens("t1", row("t1"), row("t1"))).toEqual({ current: row("t1"), retire: null });
  });

  it("revokes only the stored token when the file lost it", () => {
    expect(serverCliTokens("t1", row("t1"), null)).toEqual({ current: null, retire: "t1" });
    // The file holds some other token (someone's own, named the same): never adopted, never revoked.
    expect(serverCliTokens("t1", row("t1"), row("theirs"))).toEqual({ current: null, retire: "t1" });
  });

  it("makes a new one when the stored token was revoked", () => {
    expect(serverCliTokens("t1", null, null)).toEqual({ current: null, retire: null });
  });

  it("adopts the file's token on the first run without a stored id", () => {
    expect(serverCliTokens(null, null, row("old"))).toEqual({ current: row("old"), retire: null });
    expect(serverCliTokens(null, null, null)).toEqual({ current: null, retire: null });
  });
});
