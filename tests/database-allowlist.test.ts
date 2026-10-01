import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {}, schema: {} }));

const { allowlistScript, familyRules } = await import("@/server/databases/allowlist");
const { normalizeTrustedRanges } = await import("@/lib/trusted-proxies");

describe("database allowlists", () => {
  const entries = [{ port: 15432, allow: ["203.0.113.7/32", "2001:db8::/32"] }];

  it("lets the listed addresses reach the port and drops the rest, per family", () => {
    const v4 = familyRules(entries, false);
    expect(v4).toEqual([
      "$T -A SERVE-DB-ALLOW -p tcp -m conntrack --ctstate DNAT --ctorigdstport 15432 --ctdir ORIGINAL -s 203.0.113.7/32 -j RETURN",
      "$T -A SERVE-DB-ALLOW -p tcp -m conntrack --ctstate DNAT --ctorigdstport 15432 --ctdir ORIGINAL -j DROP",
      "$T -A SERVE-DB-ALLOW-IN -p tcp --dport 15432 -s 203.0.113.7/32 -j RETURN",
      "$T -A SERVE-DB-ALLOW-IN -p tcp --dport 15432 -j DROP",
    ]);
    const v6 = familyRules(entries, true);
    expect(v6.filter((l) => l.includes("RETURN")).every((l) => l.includes("2001:db8::/32"))).toBe(true);
    // An allowlist with IPv4 addresses only shuts the port on IPv6.
    expect(familyRules([{ port: 1, allow: ["203.0.113.7/32"] }], true)).toEqual([
      "$T -A SERVE-DB-ALLOW -p tcp -m conntrack --ctstate DNAT --ctorigdstport 1 --ctdir ORIGINAL -j DROP",
      "$T -A SERVE-DB-ALLOW-IN -p tcp --dport 1 -j DROP",
    ]);
  });

  it("rebuilds Serve's chains and puts their jumps first", () => {
    const script = allowlistScript(entries);
    expect(script).toContain("$T -F SERVE-DB-ALLOW");
    expect(script).toContain("$T -I DOCKER-USER 1 -j SERVE-DB-ALLOW");
    expect(script).toContain("$T -I INPUT 1 -j SERVE-DB-ALLOW-IN");
    // Local connections (an SSH tunnel to localhost) always pass.
    expect(script).toContain("$T -A SERVE-DB-ALLOW-IN -i lo -j RETURN");
    // No allowlists: the chains are emptied, nothing is dropped.
    expect(allowlistScript([])).not.toContain("DROP");
  });

  it("accepts any range width for an allowlist", () => {
    expect(normalizeTrustedRanges(["0.0.0.0/0", "10.1.2.3"], { anyWidth: true })).toEqual({ ranges: ["0.0.0.0/0", "10.1.2.3/32"] });
    expect("error" in normalizeTrustedRanges(["10.0.0.0/4"])).toBe(true);
  });
});
