import { describe, expect, it } from "vitest";
import { CLI_LOGIN_TTL, cleanClientName, cliLoginState, newUserCode, normalizeUserCode, pollTooSoon } from "@/lib/cli-login";

describe("CLI sign-in codes", () => {
  it("makes codes like BCDF-2345 without vowels, 0 or 1", () => {
    for (let i = 0; i < 200; i++) {
      const code = newUserCode((n) => Math.floor(Math.random() * n));
      expect(code).toMatch(/^[B-DF-HJ-NP-TV-XZ]{4}-[2-9]{4}$/);
    }
    expect(newUserCode(() => 0)).toBe("BBBB-2222");
  });

  it("reads codes as people type them", () => {
    expect(normalizeUserCode("bcdf-2345")).toBe("BCDF-2345");
    expect(normalizeUserCode(" BCDF 2345 ")).toBe("BCDF-2345");
    expect(normalizeUserCode("BCDF2345")).toBe("BCDF-2345");
    expect(normalizeUserCode("BCDF-234")).toBeNull();
    expect(normalizeUserCode("1234-ABCD")).toBeNull();
    expect(normalizeUserCode(undefined)).toBeNull();
    expect(normalizeUserCode(["BCDF-2345"])).toBeNull();
  });

  it("expires pending and approved sign-ins after their time", () => {
    const now = Date.now();
    const at = (s: number) => new Date(now + s * 1000);
    expect(cliLoginState({ status: "pending", expiresAt: at(CLI_LOGIN_TTL) }, now)).toBe("pending");
    expect(cliLoginState({ status: "pending", expiresAt: at(0) }, now)).toBe("expired");
    expect(cliLoginState({ status: "approved", expiresAt: at(5) }, now)).toBe("approved");
    expect(cliLoginState({ status: "approved", expiresAt: at(-1) }, now)).toBe("expired");
    expect(cliLoginState({ status: "denied", expiresAt: at(-1) }, now)).toBe("denied");
    expect(cliLoginState({ status: "spent", expiresAt: at(100) }, now)).toBe("spent");
  });

  it("keeps the computer name short and printable", () => {
    expect(cleanClientName("my-laptop.local")).toBe("my-laptop.local");
    expect(cleanClientName("<script>x</script>")).toBe("scriptxscript");
    expect(cleanClientName("a".repeat(100))).toHaveLength(64);
    expect(cleanClientName("")).toBe("unknown computer");
    expect(cleanClientName(42)).toBe("unknown computer");
  });

  it("asks a client polling faster than the interval to slow down", () => {
    expect(pollTooSoon(undefined, 10_000)).toBe(false);
    expect(pollTooSoon(10_000, 11_000)).toBe(true);
    expect(pollTooSoon(10_000, 11_600)).toBe(false);
    expect(pollTooSoon(10_000, 12_000)).toBe(false);
  });
});
