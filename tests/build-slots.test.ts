import { describe, expect, it } from "vitest";
import { buildServerOf, fullBuildServers, metricsCutoff } from "@/lib/server-limits";

describe("per-server build slots", () => {
  it("marks only the servers that reached their own limit", () => {
    const limits = new Map([
      ["local", 2],
      ["big", 4],
    ]);
    expect(fullBuildServers(["local", "local", "big"], limits)).toEqual(["local"]);
    expect(fullBuildServers(["big", "big", "big"], limits)).toEqual([]);
    expect(fullBuildServers(["big", "big", "big", "big", null], limits)).toEqual(["big"]);
  });

  it("uses the default for servers without a saved limit, and at least one slot", () => {
    expect(fullBuildServers(["new", "new"], new Map())).toEqual(["new"]);
    expect(fullBuildServers(["zero"], new Map([["zero", 0]]))).toEqual(["zero"]);
  });

  it("counts a deploy against its build server when it has one", () => {
    expect(buildServerOf({ serverId: "app", distribution: { buildServerId: "builder" } })).toBe("builder");
    expect(buildServerOf({ serverId: "app", distribution: { buildServerId: null } })).toBe("app");
    expect(buildServerOf({ serverId: "app" })).toBe("app");
  });
});

describe("metrics retention", () => {
  it("keeps the configured hours, never less than one", () => {
    const now = Date.UTC(2026, 0, 2, 0, 0, 0);
    expect(metricsCutoff(48, now).toISOString()).toBe("2025-12-31T00:00:00.000Z");
    expect(metricsCutoff(0, now).toISOString()).toBe("2026-01-01T23:00:00.000Z");
  });
});
