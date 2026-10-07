import { describe, expect, it } from "vitest";
import { bestCertificate } from "@/server/ssl/match";

const cert = (name: string, domains: string[], status: string, expiresAt: string | null) => ({ name, domains, status, expiresAt });

describe("bestCertificate", () => {
  it("takes an active certificate of the name itself before a wildcard, then the one valid longest", () => {
    const certs = [
      cert("old wildcard", ["*.example.com"], "active", "2026-12-01"),
      cert("new wildcard", ["example.com", "*.example.com"], "active", "2027-03-01"),
      cert("own, expiring", ["status.example.com"], "active", "2026-11-01"),
      cert("own, failed", ["status.example.com"], "failed", "2027-06-01"),
    ];
    expect(bestCertificate("status.example.com", certs)?.name).toBe("own, expiring");
    expect(bestCertificate("STATUS.example.com", certs.slice(0, 2))?.name).toBe("new wildcard");
  });

  it("takes one browsers trust before a Cloudflare Origin certificate, which only Cloudflare's proxy trusts", () => {
    const certs = [
      { ...cert("origin, own name", ["status.example.com"], "active", "2040-01-01"), provider: "cloudflare-origin" },
      { ...cert("letsencrypt wildcard", ["*.example.com"], "active", "2026-12-01"), provider: "letsencrypt-cloudflare" },
    ];
    expect(bestCertificate("status.example.com", certs)?.name).toBe("letsencrypt wildcard");
    expect(bestCertificate("status.example.com", certs.slice(0, 1))?.name).toBe("origin, own name");
  });

  it("finds none for names nothing active covers", () => {
    expect(bestCertificate("a.b.example.com", [cert("wildcard", ["*.example.com"], "active", null)])).toBeUndefined();
    expect(bestCertificate("x.example.com", [cert("pending", ["*.example.com"], "pending", null)])).toBeUndefined();
  });
});
