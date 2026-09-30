import { describe, expect, it } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-domain-ownership";
process.env.DATABASE_URL ??= "postgres://x:y@127.0.0.1:1/none";
const { ownershipCandidates, ownershipExempt, trustedWildcards, verificationValue } = await import("@/server/domains/ownership");

describe("domain ownership", () => {
  it("checks the name and each parent", () => {
    expect(ownershipCandidates("a.b.example.com")).toEqual(["a.b.example.com", "b.example.com", "example.com"]);
    expect(ownershipCandidates("*.example.com")).toEqual(["example.com"]);
    expect(ownershipCandidates("Example.COM.")).toEqual(["example.com"]);
  });

  it("gives each organization its own value", () => {
    expect(verificationValue("org1")).toMatch(/^serve-verify=[0-9a-f]{32}$/);
    expect(verificationValue("org1")).toBe(verificationValue("org1"));
    expect(verificationValue("org1")).not.toBe(verificationValue("org2"));
  });

  it("needs no proof for names Serve generates", () => {
    expect(ownershipExempt("app.203.0.113.9.sslip.io", [])).toBe(true);
    expect(ownershipExempt("app.nip.io", [])).toBe(true);
    expect(ownershipExempt("web.apps.example.com", ["apps.example.com"])).toBe(true);
    expect(ownershipExempt("apps.example.com", ["apps.example.com"])).toBe(false);
    expect(ownershipExempt("evilapps.example.com", ["apps.example.com"])).toBe(false);
    expect(ownershipExempt("shop.example.com", ["apps.example.com"])).toBe(false);
  });

  it("trusts only wildcards of servers the organization deploys to", () => {
    const servers = [
      { wildcardDomain: "apps.instance.com", ownerOrganizationId: null, organizationIds: null },
      { wildcardDomain: "apps.private.com", ownerOrganizationId: null, organizationIds: ["other"] },
      { wildcardDomain: "victim.com", ownerOrganizationId: "attacker", organizationIds: [] },
      { wildcardDomain: "apps.mine.com", ownerOrganizationId: "me", organizationIds: [] },
      { wildcardDomain: null, ownerOrganizationId: null, organizationIds: null },
    ];
    expect(trustedWildcards(servers, "me")).toEqual(["apps.instance.com", "apps.mine.com"]);
    // Another organization's server wildcard never exempts names for anyone else.
    expect(trustedWildcards(servers, "someone")).toEqual(["apps.instance.com"]);
    expect(trustedWildcards(servers, "other")).toEqual(["apps.instance.com", "apps.private.com"]);
  });
});
