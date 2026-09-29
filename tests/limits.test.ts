import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {}, schema: {} }));
vi.mock("@/server/settings", () => ({ getSettings: vi.fn() }));

import { firstOverLimit, formatLimitValue, hasAnyLimit, limitError, normalizeLimits, usageLevel } from "@/lib/limits";
import { serverProblem, serviceReservation, withReservation } from "@/server/limits";

describe("usageLevel", () => {
  it("is ok without a limit and below 80 %", () => {
    expect(usageLevel(100, null)).toBe("ok");
    expect(usageLevel(7, 10)).toBe("ok");
  });
  it("warns from 80 % and is full at the limit", () => {
    expect(usageLevel(8, 10)).toBe("warn");
    expect(usageLevel(10, 10)).toBe("full");
    expect(usageLevel(0, 0)).toBe("full");
  });
});

describe("limitError", () => {
  it("allows adding up to the limit", () => {
    expect(limitError("services", 4, 1, 5)).toBeNull();
    expect(limitError("services", 5, 0, 5)).toBeNull();
  });
  it("refuses going over, with the numbers", () => {
    expect(limitError("services", 5, 1, 5)).toMatch(/services limit \(5 of 5 used\)/);
    expect(limitError("memory", 900, 256, 1024)).toMatch(/900 MB of 1024 MB/);
  });
  it("ignores missing limits", () => {
    expect(limitError("projects", 1000, 1, undefined)).toBeNull();
  });
});

describe("firstOverLimit", () => {
  const usage = { projects: 2, services: 3, apps: 3, databases: 0, cpu: 1.5, memory: 1536, disk: 4, domains: 1 };
  it("names the first limit a new service breaks", () => {
    expect(firstOverLimit({ services: 10, apps: 3 }, usage, { services: 1, apps: 1 })?.key).toBe("apps");
    expect(firstOverLimit({ cpu: 2 }, usage, { services: 1, cpu: 0.5 })).toBeNull();
    expect(firstOverLimit({ cpu: 2 }, usage, { services: 1, cpu: 1 })?.key).toBe("cpu");
  });
  it("refuses new services when volume storage is full, but not other additions", () => {
    expect(firstOverLimit({ disk: 4 }, usage, { services: 1 })?.key).toBe("disk");
    expect(firstOverLimit({ disk: 4 }, usage, { domains: 1 })).toBeNull();
  });
  it("passes with no limits at all", () => {
    expect(firstOverLimit({}, usage, { projects: 5, services: 5, domains: 5 })).toBeNull();
  });
});

describe("reservations", () => {
  it("counts services without a limit at the default once a limit applies", () => {
    expect(serviceReservation({ cpuLimit: null, memoryLimit: null }, { cpu: 4 })).toEqual({ cpu: 0.5, memory: 0 });
    expect(serviceReservation({ cpuLimit: null, memoryLimit: null }, { memory: 4096, defaultMemory: 256 })).toEqual({ cpu: 0, memory: 256 });
    expect(serviceReservation({ cpuLimit: 2, memoryLimit: 1024 }, { cpu: 4, memory: 4096 })).toEqual({ cpu: 2, memory: 1024 });
  });
  it("gives new services the reservation only when they have no limit", () => {
    expect(withReservation({ cpuLimit: null, memoryLimit: null }, { cpuLimit: 0.5, memoryLimit: 512 })).toEqual({ cpuLimit: 0.5, memoryLimit: 512 });
    expect(withReservation({ cpuLimit: 1, memoryLimit: null }, { cpuLimit: 0.5, memoryLimit: null })).toEqual({ cpuLimit: 1, memoryLimit: null });
  });
});

describe("serverProblem", () => {
  it("enforces the allow list", () => {
    expect(serverProblem({ allowedServers: ["a"] }, new Set(), "b")).toMatch(/may not use that server/);
    expect(serverProblem({ allowedServers: ["a"] }, new Set(), "a")).toBeNull();
  });
  it("counts only servers not in use yet", () => {
    expect(serverProblem({ servers: 1 }, new Set(["a"]), "a")).toBeNull();
    expect(serverProblem({ servers: 1 }, new Set(["a"]), "b")).toMatch(/servers limit \(1 of 1 used\)/);
  });
});

describe("normalizeLimits", () => {
  it("keeps valid numbers and drops empty or negative ones", () => {
    expect(normalizeLimits({ services: 4.6, cpu: 1.234, memory: -1, projects: null, allowedServers: ["a", "a", ""] })).toEqual({ services: 5, cpu: 1.23, allowedServers: ["a"] });
  });
  it("detects whether anything is limited", () => {
    expect(hasAnyLimit({})).toBe(false);
    expect(hasAnyLimit({ domains: 0 })).toBe(true);
    expect(hasAnyLimit({ allowedServers: [] })).toBe(true);
  });
  it("formats values with their unit", () => {
    expect(formatLimitValue("cpu", 1.5)).toBe("1.5 cores");
    expect(formatLimitValue("disk", 0.25)).toBe("0.25 GB");
    expect(formatLimitValue("services", 3)).toBe("3");
  });
});
