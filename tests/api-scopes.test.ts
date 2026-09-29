import { describe, expect, it } from "vitest";
import { expandScopes, hasScope, impliedScopes, normalizeScopes } from "@/lib/api-scopes";

describe("API token scopes", () => {
  it("admin implies every scope", () => {
    expect([...expandScopes(["admin"])].sort()).toEqual(["admin", "deploy", "read", "read:sensitive", "write"]);
  });
  it("write implies read and deploy but not sensitive reads", () => {
    expect(hasScope(["write"], "deploy")).toBe(true);
    expect(hasScope(["write"], "read")).toBe(true);
    expect(hasScope(["write"], "read:sensitive")).toBe(false);
    expect(hasScope(["write"], "admin")).toBe(false);
  });
  it("read does not allow deploys", () => {
    expect(hasScope(["read"], "deploy")).toBe(false);
    expect(hasScope(["read:sensitive"], "read")).toBe(true);
  });
  it("ignores unknown scopes", () => {
    expect(expandScopes(["root", "read"]).has("admin")).toBe(false);
  });
  it("normalizes to the smallest equivalent set", () => {
    expect(normalizeScopes(["read", "deploy", "write", "bogus"])).toEqual(["write"]);
    expect(normalizeScopes(["read", "read:sensitive", "deploy"])).toEqual(["read:sensitive", "deploy"]);
    expect([...impliedScopes(["write"])].sort()).toEqual(["deploy", "read"]);
  });
});
