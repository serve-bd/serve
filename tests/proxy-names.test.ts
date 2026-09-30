import { describe, expect, it } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-proxy-names";
process.env.DATABASE_URL ??= "postgres://x:y@127.0.0.1:1/none";
const { upstreamNamer } = await import("@/server/proxy/names");
const { certificateStamp } = await import("@/server/proxy/model");
const { freeTunnelSubnet } = await import("@/server/proxy/tunnel-network");

describe("nginx upstream names", () => {
  it("keeps the plain name when no other key on the server shares it", () => {
    const name = upstreamNamer([
      { slug: "web-abc123", suffix: "3000" },
      { slug: "api-def456", suffix: "api.v2_8080" },
    ]);
    expect(name("web-abc123", "3000")).toBe("svc_web_abc123_3000");
    expect(name("api-def456", "api.v2_8080")).toBe("svc_api_def456_api_v2_8080");
    // A key the list does not know yet cannot collide with it either.
    expect(name("new-xyz789", "80")).toBe("svc_new_xyz789_80");
  });

  it("hashes only names that different keys share once sanitized", () => {
    const keys = [
      { slug: "a", suffix: "b_80" },
      { slug: "a-b", suffix: "80" },
      { slug: "a_b", suffix: "80" },
      { slug: "a", suffix: "b_80" },
      { slug: "other", suffix: "80" },
    ];
    const name = upstreamNamer(keys);
    const colliding = [name("a", "b_80"), name("a-b", "80"), name("a_b", "80")];
    expect(new Set(colliding).size).toBe(3);
    for (const n of colliding) expect(n).toMatch(/^svc_a_b_80_[0-9a-f]{8}$/);
    expect(name("other", "80")).toBe("svc_other_80");
    // Deterministic: the same keys in any order give the same names.
    expect(upstreamNamer([...keys].reverse())("a-b", "80")).toBe(name("a-b", "80"));
  });
});

describe("certificate stamp", () => {
  const cert = (id: string, expiresAt: string) =>
    ({ id, certPath: `/etc/letsencrypt/live/${id}/fullchain.pem`, expiresAt: new Date(expiresAt) }) as Parameters<typeof certificateStamp>[0][number];

  it("names only the certificates a site serves, with their expiry", () => {
    const used = [{ cert: "/etc/letsencrypt/live/c1/fullchain.pem" }, null, undefined];
    expect(certificateStamp([cert("c1", "2026-01-01T00:00:00Z"), cert("c2", "2026-02-01T00:00:00Z")], used)).toEqual(["# Certificate c1 valid until 2026-01-01T00:00:00.000Z."]);
  });

  it("changes when a certificate is renewed, so the proxy reloads it", () => {
    const used = [{ cert: "/etc/letsencrypt/live/c1/fullchain.pem" }];
    expect(certificateStamp([cert("c1", "2026-01-01T00:00:00Z")], used)).not.toEqual(certificateStamp([cert("c1", "2026-04-01T00:00:00Z")], used));
  });
});

describe("tunnel network range", () => {
  it("picks the first /26 that overlaps no existing network", () => {
    expect(freeTunnelSubnet([])).toBe("10.222.0.0/26");
    expect(freeTunnelSubnet(["10.222.0.0/25", "fd00::/64"])).toBe("10.222.0.128/26");
    expect(freeTunnelSubnet(["10.222.0.64/26"])).toBe("10.222.0.0/26");
    // A wide network covering the start pushes past it.
    expect(freeTunnelSubnet(["10.222.0.0/23"])).toBe("10.222.2.0/26");
    expect(freeTunnelSubnet(["10.0.0.0/8"])).toBeNull();
  });
});
