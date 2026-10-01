import { describe, expect, it } from "vitest";
import { normalizeGrants, tokenGrants } from "@/lib/api-scopes";
import { PERMISSIONS } from "@/lib/permissions";

describe("API token permissions", () => {
  it("admin gives every permission", () => {
    const g = tokenGrants(["admin"]);
    expect(g.admin).toBe(true);
    expect([...g.permissions].sort()).toEqual([...PERMISSIONS].sort());
  });
  it("keeps old scopes doing what they did", () => {
    expect([...tokenGrants(["read"]).permissions].sort()).toEqual(["logs.view", "projects.view"]);
    expect(tokenGrants(["deploy"]).permissions.has("services.deploy")).toBe(true);
    expect(tokenGrants(["write"]).permissions.has("variables.view-secrets")).toBe(false);
    expect(tokenGrants(["write"]).permissions.has("variables.edit")).toBe(true);
    expect(tokenGrants(["read:sensitive"]).permissions.has("variables.view-secrets")).toBe(true);
    expect(tokenGrants(["write"]).admin).toBe(false);
  });
  it("takes permissions as they are and ignores unknown ones", () => {
    const g = tokenGrants(["services.deploy", "root", "members.manage"]);
    expect([...g.permissions].sort()).toEqual(["members.manage", "services.deploy"]);
    expect(g.admin).toBe(false);
  });
  it("normalizes to canonical order, admin alone", () => {
    expect(normalizeGrants(["services.deploy", "projects.view", "bogus"])).toEqual(["projects.view", "services.deploy"]);
    expect(normalizeGrants(["read", "deploy"])).toEqual(["projects.view", "services.deploy", "logs.view"]);
    expect(normalizeGrants(["projects.view", "admin"])).toEqual(["admin"]);
  });
});
