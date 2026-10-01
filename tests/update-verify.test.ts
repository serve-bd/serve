import { describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET = "test-secret-for-update-verify";
vi.mock("@/server/docker/client", () => ({ docker: {} }));
const { pinned, signerPattern } = await import("@/server/instance/verify");
const { encrypt, decrypt, decryptOrNull } = await import("@/server/crypto");

describe("release signatures", () => {
  it("accepts only the image workflow of the repository, run for a tag", () => {
    const re = new RegExp(signerPattern("serve-bd/serve"));
    expect(re.test("https://github.com/serve-bd/serve/.github/workflows/image.yml@refs/tags/v0.1.15")).toBe(true);
    expect(re.test("https://github.com/serve-bd/serve/.github/workflows/image.yml@refs/heads/main")).toBe(false);
    expect(re.test("https://github.com/serve-bd/serve/.github/workflows/ci.yml@refs/tags/v0.1.15")).toBe(false);
    expect(re.test("https://github.com/serve-bdXserve/.github/workflows/image.yml@refs/tags/v1")).toBe(false);
    expect(re.test("https://github.com/evil/serve-bd/serve/.github/workflows/image.yml@refs/tags/v1")).toBe(false);
  });

  it("pins the tag to the checked digest", () => {
    expect(pinned("ghcr.io/serve-bd/serve:0.1.15", "ghcr.io/serve-bd/serve@sha256:abc")).toBe("ghcr.io/serve-bd/serve:0.1.15@sha256:abc");
  });
});

describe("stored secrets", () => {
  it("refuses values that were not encrypted", () => {
    expect(decrypt(encrypt("pw"))).toBe("pw");
    expect(() => decrypt("plain")).toThrow(/not encrypted/);
    expect(decryptOrNull("plain")).toBeNull();
  });
});
