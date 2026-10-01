import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {}, schema: {} }));

const { allowlistScript, familyRules } = await import("@/server/databases/allowlist");
const { normalizeTrustedRanges } = await import("@/lib/trusted-proxies");

describe("database allowlists", () => {
  const entries = [{ port: 15432, allow: ["203.0.113.7/32", "2001:db8::/32"] }];

  it("lets the listed addresses reach the port and drops the rest, per family", () => {
    const v4 = familyRules(entries, false);
    expect(v4).toEqual([
      "-A SERVE-DB-ALLOW-IN -i lo -j RETURN",
      "-A SERVE-DB-ALLOW -p tcp -m conntrack --ctstate DNAT --ctorigdstport 15432 --ctdir ORIGINAL -s 203.0.113.7/32 -j RETURN",
      "-A SERVE-DB-ALLOW -p tcp -m conntrack --ctstate DNAT --ctorigdstport 15432 --ctdir ORIGINAL -j DROP",
      "-A SERVE-DB-ALLOW-IN -p tcp --dport 15432 -s 203.0.113.7/32 -j RETURN",
      "-A SERVE-DB-ALLOW-IN -p tcp --dport 15432 -m conntrack --ctstate NEW -j DROP",
    ]);
    const v6 = familyRules(entries, true);
    expect(v6.filter((l) => l.includes("RETURN") && !l.includes("-i lo")).every((l) => l.includes("2001:db8::/32"))).toBe(true);
    // An allowlist with IPv4 addresses only shuts the port on IPv6.
    expect(familyRules([{ port: 1, allow: ["203.0.113.7/32"] }], true)).toEqual([
      "-A SERVE-DB-ALLOW-IN -i lo -j RETURN",
      "-A SERVE-DB-ALLOW -p tcp -m conntrack --ctstate DNAT --ctorigdstport 1 --ctdir ORIGINAL -j DROP",
      "-A SERVE-DB-ALLOW-IN -p tcp --dport 1 -m conntrack --ctstate NEW -j DROP",
    ]);
  });

  it("replaces Serve's chains at once, hooks them and checks they are in place", () => {
    const script = allowlistScript(entries);
    expect(script).toContain(":SERVE-DB-ALLOW - [0:0]");
    expect(script).toContain("$T-restore -w 10 --noflush");
    expect(script).toContain("$T -w 10 -I $HOOK 1 -j SERVE-DB-ALLOW");
    expect(script).toContain("HOOK=FORWARD; $T -w 10 -S DOCKER-USER >/dev/null 2>&1 && HOOK=DOCKER-USER");
    expect(script).toContain('fail "the rules are not in place on $T"');
    // Local connections (an SSH tunnel to localhost) always pass.
    expect(script).toContain("-A SERVE-DB-ALLOW-IN -i lo -j RETURN");
    // An allowlist on a server without iptables fails; no allowlists there is fine.
    expect(script).toContain('fail "iptables is not installed on this server"');
    expect(allowlistScript([])).not.toContain("DROP");
    expect(allowlistScript([])).toContain("exit 0");
  });

  it("accepts any range width for an allowlist", () => {
    expect(normalizeTrustedRanges(["0.0.0.0/0", "10.1.2.3"], { anyWidth: true })).toEqual({ ranges: ["0.0.0.0/0", "10.1.2.3/32"] });
    expect("error" in normalizeTrustedRanges(["10.0.0.0/4"])).toBe(true);
  });
});

describe("preview scrub SQL in branch scripts", async () => {
  const { pipeSql, branchScripts } = await import("@/server/databases/branches");
  it("never lets the text end the quoting", () => {
    const evil = "SELECT 1;\nSERVE_SCRUB_SQL_END\nid > /tmp/pwned\ncat <<'SERVE_SCRUB_SQL_END'\n'; rm -rf / #";
    const script = branchScripts("mysql").create({ database: "app", username: "app", password: "p" }, { database: "app__b", username: "app__b", password: "x" }, evil);
    expect(script).not.toContain("pwned");
    expect(script).not.toContain("rm -rf");
    expect(pipeSql(evil)).toMatch(/^printf '%s' '[A-Za-z0-9+/=]+' \| base64 -d$/);
    expect(Buffer.from(pipeSql(evil).split("'")[3], "base64").toString("utf8")).toBe(evil);
  });
});

describe("secret references", async () => {
  const { parseSecretRef } = await import("@/lib/secret-providers");
  it("keeps paths under the provider's mount", () => {
    expect(parseSecretRef("vault.app/db:PASSWORD")).toEqual({ provider: "vault", path: "app/db", field: "PASSWORD" });
    for (const bad of ["vault.../other/x", "vault.a/../b", "vault.a//b", "vault../x", "vault.a/./b"]) expect(parseSecretRef(bad)).toBeNull();
  });
});
