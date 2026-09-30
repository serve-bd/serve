import { describe, expect, it } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-proxy-names";
process.env.DATABASE_URL ??= "postgres://x:y@127.0.0.1:1/none";
const { upstreamName } = await import("@/server/proxy/names");
const { certificateStamp } = await import("@/server/proxy/model");

describe("nginx upstream names", () => {
  it("keeps names apart that read the same once sanitized", () => {
    const names = [upstreamName("a", "b_80"), upstreamName("a-b", "80"), upstreamName("a_b", "80"), upstreamName("a", "b-80"), upstreamName("a", "b.80")];
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives the same parts the same valid name", () => {
    expect(upstreamName("web-abc123", "3000")).toBe(upstreamName("web-abc123", "3000"));
    expect(upstreamName("web-abc123", "api.v2_8080")).toMatch(/^svc_web_abc123_api_v2_8080_[0-9a-f]{8}$/);
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
