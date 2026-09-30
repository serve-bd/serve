import { describe, expect, it } from "vitest";
import { canAddServers, canManageServer, ownerFor, serverAllowsOrg } from "@/server/servers/ownership";

const ctx = (o: Partial<{ isInstanceAdmin: boolean; isAdmin: boolean; isRoot: boolean; org: string }> = {}) => ({
  isInstanceAdmin: o.isInstanceAdmin ?? false,
  isAdmin: o.isAdmin ?? false,
  isRoot: o.isRoot ?? false,
  org: { id: o.org ?? "acme" },
});

describe("server ownership", () => {
  it("the owner always deploys to its server; others only when shared", () => {
    const own = { ownerOrganizationId: "acme", organizationIds: [] };
    expect(serverAllowsOrg(own, "acme")).toBe(true);
    expect(serverAllowsOrg(own, "globex")).toBe(false);
    expect(serverAllowsOrg({ ...own, organizationIds: ["globex"] }, "globex")).toBe(true);
    expect(serverAllowsOrg({ ownerOrganizationId: null, organizationIds: null }, "anyone")).toBe(true);
    expect(serverAllowsOrg({ ownerOrganizationId: null, organizationIds: ["root"] }, "acme")).toBe(false);
  });

  it("Root admins manage every server, org admins only their own", () => {
    const acmes = { ownerOrganizationId: "acme" };
    const instance = { ownerOrganizationId: null };
    expect(canManageServer(ctx({ isInstanceAdmin: true }), acmes)).toBe(true);
    expect(canManageServer(ctx({ isInstanceAdmin: true }), instance)).toBe(true);
    expect(canManageServer(ctx({ isAdmin: true }), acmes)).toBe(true);
    expect(canManageServer(ctx({ isAdmin: true }), instance)).toBe(false);
    expect(canManageServer(ctx({ isAdmin: true, org: "globex" }), acmes)).toBe(false);
    // A shared server is used, not managed; members who are not admins manage nothing.
    expect(canManageServer(ctx({ isAdmin: false }), acmes)).toBe(false);
  });

  it("who may add servers, and who owns them", () => {
    expect(canAddServers(ctx({ isRoot: true, isAdmin: true }))).toBe(false);
    expect(canAddServers(ctx({ isRoot: true, isInstanceAdmin: true, isAdmin: true }))).toBe(true);
    expect(canAddServers(ctx({ isAdmin: true }))).toBe(true);
    expect(canAddServers(ctx({}))).toBe(false);
    expect(ownerFor(ctx({ isRoot: true }))).toBeNull();
    expect(ownerFor(ctx({ org: "acme" }))).toBe("acme");
  });
});

describe("organization server addresses", () => {
  it("accepts only public addresses", async () => {
    const { publicAddress } = await import("@/server/net/public-host");
    expect(await publicAddress("8.8.8.8")).toBe("8.8.8.8");
    for (const host of ["127.0.0.1", "10.0.0.5", "192.168.1.2", "172.18.0.3", "169.254.169.254", "::1", "[::1]", "localhost", "no-such-host.invalid"]) {
      expect(await publicAddress(host)).toBeNull();
    }
  });
});
