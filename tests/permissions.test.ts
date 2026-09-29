import { beforeEach, describe, expect, it, vi } from "vitest";

// A tiny stand-in for the database: each select resolves to the next queued result.
const queue: unknown[][] = [];
const chain = () => {
  const c: Record<string, unknown> = {};
  for (const k of ["from", "innerJoin", "leftJoin", "orderBy", "limit"]) c[k] = () => c;
  c.where = () => Promise.resolve(queue.shift() ?? []);
  return c;
};
vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => ({
  db: {
    select: () => chain(),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  },
  schema: new Proxy({}, { get: () => new Proxy({}, { get: () => ({}) }) }),
}));
vi.mock("drizzle-orm", async (orig) => ({ ...(await orig<typeof import("drizzle-orm")>()), and: () => ({}), eq: () => ({}) }));

const session = { ctx: null as null | { org: { id: string }; canAccessProject: (id: string) => boolean } };
vi.mock("@/server/auth", () => ({ sessionOrgContext: async () => session.ctx }));

const owner = { access: null as null | { roleId: string; roleName: string; permissions: Set<string>; projectIds: string[] | null } };
vi.mock("@/server/permissions", () => ({ memberAccess: async () => owner.access }));

import { allowedScopes, BUILTIN_PERMISSIONS, canGrant, effectiveRoleId, memberRoleFor, normalizePermissions, PERMISSIONS, type Permission } from "@/lib/permissions";
import { serviceInOrg } from "@/server/services/access";
import { requireToken } from "@/server/api-auth";
import { sha256 } from "@/server/crypto";

describe("member access", async () => {
  const { accessFrom } = await vi.importActual<typeof import("@/server/permissions")>("@/server/permissions");
  const roles = [
    { id: "owner", name: "Owner", description: null, builtin: "owner" as const, permissions: [...PERMISSIONS] },
    { id: "admin", name: "Admin", description: null, builtin: "admin" as const, permissions: [...PERMISSIONS] },
    { id: "developer", name: "Developer", description: null, builtin: "developer" as const, permissions: [...BUILTIN_PERMISSIONS.developer] },
    { id: "viewer", name: "Viewer", description: null, builtin: "viewer" as const, permissions: [...BUILTIN_PERMISSIONS.viewer] },
    { id: "rel", name: "Release", description: null, builtin: null, permissions: ["projects.view", "services.deploy"] as Permission[] },
  ];

  it("resolves built-in, custom and missing roles", () => {
    expect(accessFrom({ role: "member", roleId: null, projectIds: null }, roles).roleId).toBe("developer");
    expect([...accessFrom({ role: "member", roleId: "rel", projectIds: null }, roles).permissions]).toEqual(["projects.view", "services.deploy"]);
    // A deleted custom role never grants more than Viewer.
    expect(accessFrom({ role: "member", roleId: "gone", projectIds: null }, roles).roleId).toBe("viewer");
  });

  it("limits projects for members only", () => {
    expect(accessFrom({ role: "member", roleId: null, projectIds: ["p1"] }, roles).projectIds).toEqual(["p1"]);
    expect(accessFrom({ role: "admin", roleId: null, projectIds: ["p1"] }, roles).projectIds).toBeNull();
    expect(accessFrom({ role: "member", roleId: null, projectIds: [] }, roles).projectIds).toBeNull();
  });
});

describe("built-in roles", () => {
  it("owners and admins can do everything", () => {
    expect([...BUILTIN_PERMISSIONS.owner]).toEqual([...PERMISSIONS]);
    expect([...BUILTIN_PERMISSIONS.admin]).toEqual([...PERMISSIONS]);
  });

  it("developers deploy but do not see secrets or manage the organization", () => {
    const dev = BUILTIN_PERMISSIONS.developer;
    expect(dev).toContain("services.deploy");
    expect(dev).toContain("variables.edit");
    expect(dev).not.toContain("variables.view-secrets");
    expect(dev).not.toContain("members.manage");
    expect(dev).not.toContain("integrations.manage");
  });

  it("viewers are read-only", () => {
    expect([...BUILTIN_PERMISSIONS.viewer].sort()).toEqual(["logs.view", "projects.view"]);
  });
});

describe("roles and member rows", () => {
  it("derives the role id from the stored role", () => {
    expect(effectiveRoleId("owner", "viewer")).toBe("owner");
    expect(effectiveRoleId("admin", null)).toBe("admin");
    expect(effectiveRoleId("member", null)).toBe("developer");
    expect(effectiveRoleId("member", "viewer")).toBe("viewer");
    expect(effectiveRoleId("member", "abc123")).toBe("abc123");
    // A member row can never claim admin through role_id.
    expect(effectiveRoleId("member", "admin")).toBe("developer");
  });

  it("keeps better-auth's role in step", () => {
    expect(memberRoleFor("owner")).toBe("owner");
    expect(memberRoleFor("admin")).toBe("admin");
    expect(memberRoleFor("developer")).toBe("member");
    expect(memberRoleFor("custom-id")).toBe("member");
  });

  it("normalizes permission lists", () => {
    expect(normalizePermissions(["logs.view", "nope", "logs.view"])).toEqual(["projects.view", "logs.view"]);
  });
});

describe("who may grant which role", () => {
  const role = (id: string, permissions: Permission[]) => ({ id, permissions });
  const dev = role("developer", [...BUILTIN_PERMISSIONS.developer]);
  it("owners grant anything, admins anything but Owner", () => {
    expect(canGrant({ roleId: "owner", permissions: [] }, role("owner", []))).toBe(true);
    expect(canGrant({ roleId: "admin", permissions: [...PERMISSIONS] }, role("owner", []))).toBe(false);
    expect(canGrant({ roleId: "admin", permissions: [...PERMISSIONS] }, role("admin", []))).toBe(true);
  });

  it("others only grant roles within their own permissions", () => {
    const manager = { roleId: "custom", permissions: [...BUILTIN_PERMISSIONS.developer, "members.manage" as const] };
    expect(canGrant(manager, dev)).toBe(true);
    expect(canGrant(manager, role("viewer", ["projects.view", "logs.view"]))).toBe(true);
    expect(canGrant(manager, role("admin", []))).toBe(false);
    expect(canGrant(manager, role("x", ["projects.view", "variables.view-secrets"]))).toBe(false);
  });
});

describe("API token scopes follow the owner's role", () => {
  it("maps permissions to scopes", () => {
    expect([...allowedScopes(new Set(BUILTIN_PERMISSIONS.viewer), false)]).toEqual(["read"]);
    expect([...allowedScopes(new Set(BUILTIN_PERMISSIONS.developer), false)].sort()).toEqual(["deploy", "read", "write"]);
    expect(allowedScopes(new Set(PERMISSIONS), true).has("admin")).toBe(true);
    expect(allowedScopes(new Set(PERMISSIONS), false).has("admin")).toBe(false);
  });

  const token = "srv_testtoken123";
  const row = { id: "t1", organizationId: "o1", userId: "u1", scopes: ["write"], projectIds: null, expiresAt: null, lastUsedAt: new Date() };
  const request = () => new Request("http://x/api/v1/services", { headers: { authorization: `Bearer ${token}` } });

  beforeEach(() => {
    queue.length = 0;
  });

  it("refuses a scope the owner's role lost", async () => {
    owner.access = { roleId: "viewer", roleName: "Viewer", permissions: new Set(BUILTIN_PERMISSIONS.viewer), projectIds: null };
    queue.push([{ ...row, tokenHash: sha256(token) }]);
    const res = await requireToken(request(), "deploy");
    expect(res.error?.status).toBe(403);
    expect(await res.error?.json()).toMatchObject({ error: expect.stringContaining("no longer allows") });
  });

  it("allows what both the token and the role allow, within the owner's projects", async () => {
    owner.access = { roleId: "developer", roleName: "Developer", permissions: new Set(BUILTIN_PERMISSIONS.developer), projectIds: ["p1"] };
    queue.push([{ ...row, tokenHash: sha256(token) }]);
    const res = await requireToken(request(), "deploy");
    expect(res.auth?.has("deploy")).toBe(true);
    expect(res.auth?.has("read:sensitive")).toBe(false);
    expect(res.auth?.canAccessProject("p1")).toBe(true);
    expect(res.auth?.canAccessProject("p2")).toBe(false);
  });

  it("stops working when the owner leaves", async () => {
    owner.access = null;
    queue.push([{ ...row, tokenHash: sha256(token) }]);
    expect((await requireToken(request(), "read")).error?.status).toBe(401);
  });
});

describe("project access", () => {
  const found = [{ service: { id: "s1" }, project: { id: "p2", organizationId: "o1" } }];

  it("hides services in projects the member cannot reach", async () => {
    session.ctx = { org: { id: "o1" }, canAccessProject: (id) => id === "p1" };
    queue.push(found);
    await expect(serviceInOrg("s1", "o1")).rejects.toThrow("Service not found.");
  });

  it("finds them when the member can reach the project", async () => {
    session.ctx = { org: { id: "o1" }, canAccessProject: () => true };
    queue.push(found);
    await expect(serviceInOrg("s1", "o1")).resolves.toMatchObject({ service: { id: "s1" } });
  });

  it("leaves requests without a session to their own checks", async () => {
    session.ctx = null;
    queue.push(found);
    await expect(serviceInOrg("s1", "o1")).resolves.toBeTruthy();
  });
});
