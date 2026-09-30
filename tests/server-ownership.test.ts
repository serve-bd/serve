import { describe, expect, it } from "vitest";
import { canAddServers, canManageServer, canViewServer, ownerFor, serverAllowsOrg, serverFitsNetwork } from "@/server/servers/ownership";

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

describe("servers listed in the active organization", () => {
  it("shows every server in Root, and only available ones elsewhere", async () => {
    const { listedInOrg } = await import("@/server/servers/ownership");
    const rootAdmin = { isInstanceAdmin: true, isAdmin: true, isRoot: true, org: { id: "root" } };
    const rootAdminInAcme = { ...rootAdmin, isRoot: false, org: { id: "acme" } };
    const acmeAdmin = { isInstanceAdmin: false, isAdmin: true, isRoot: false, org: { id: "acme" } };
    const instanceOnlyRoot = { ownerOrganizationId: null, organizationIds: ["root"] };
    const sharedWithAcme = { ownerOrganizationId: null, organizationIds: ["root", "acme"] };
    const acmeOwn = { ownerOrganizationId: "acme", organizationIds: [] };
    expect(listedInOrg(rootAdmin, instanceOnlyRoot)).toBe(true);
    expect(listedInOrg(rootAdmin, acmeOwn)).toBe(true);
    expect(listedInOrg(rootAdminInAcme, instanceOnlyRoot)).toBe(false);
    expect(listedInOrg(rootAdminInAcme, sharedWithAcme)).toBe(true);
    expect(listedInOrg(rootAdminInAcme, acmeOwn)).toBe(true);
    expect(listedInOrg(acmeAdmin, sharedWithAcme)).toBe(false);
    expect(listedInOrg(acmeAdmin, acmeOwn)).toBe(true);
  });
});

describe("shared servers", () => {
  const shared = { ownerOrganizationId: null, organizationIds: ["root", "acme"] };
  const rootOnly = { ownerOrganizationId: null, organizationIds: ["root"] };
  const betas = { ownerOrganizationId: "beta", organizationIds: [] };
  const member = (isAdmin: boolean) => ({ isInstanceAdmin: false, isAdmin, org: { id: "acme" } });

  it("every member of an organization it is shared with sees it; nobody else", () => {
    expect(canViewServer(member(false), shared)).toBe(true);
    expect(canViewServer(member(true), shared)).toBe(true);
    expect(canViewServer(member(true), rootOnly)).toBe(false);
    expect(canViewServer(member(true), betas)).toBe(false);
  });

  it("seeing is not managing", () => {
    expect(canManageServer(member(true), shared)).toBe(false);
  });

  it("fits the networks of organizations it belongs to or is shared with", () => {
    expect(serverFitsNetwork({ organizationId: "acme" }, shared)).toBe(true);
    expect(serverFitsNetwork({ organizationId: "acme" }, rootOnly)).toBe(false);
    expect(serverFitsNetwork({ organizationId: "beta" }, betas)).toBe(true);
    expect(serverFitsNetwork({ organizationId: "acme" }, betas)).toBe(false);
    // The instance's networks hold only instance servers.
    expect(serverFitsNetwork({ organizationId: null }, shared)).toBe(true);
    expect(serverFitsNetwork({ organizationId: null }, betas)).toBe(false);
  });
});
