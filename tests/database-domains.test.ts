import { describe, expect, it, vi } from "vitest";
import { hostnamePattern, tunnelTargetPort } from "@/lib/database-domains";

vi.mock("@/server/db", () => ({ db: {}, schema: {} }));

const { domainCertMount } = await import("@/server/databases/domain-tls");
const ctx = { paths: { letsencrypt: "/data/serve/letsencrypt", certs: "/data/serve/certs" } } as Parameters<typeof domainCertMount>[0];

describe("database domains", () => {
  it("leads tunnels to the engine's port, ClickHouse's native one", () => {
    expect(tunnelTargetPort("postgres", 5432)).toBe(5432);
    expect(tunnelTargetPort("clickhouse", 8123)).toBe(8123);
  });

  it("mounts only the domain's own certificate into the database", () => {
    const le = domainCertMount(ctx, { id: "c1", certPath: "/etc/letsencrypt/live/c1/fullchain.pem", keyPath: "/etc/letsencrypt/live/c1/privkey.pem" })!;
    // live/ holds links into archive/: both are bound at the same relative places.
    expect(le.binds).toEqual(["/data/serve/letsencrypt/live/c1:/etc/serve-domain-cert/live/c1:ro", "/data/serve/letsencrypt/archive/c1:/etc/serve-domain-cert/archive/c1:ro"]);
    expect(le.cert).toBe("/etc/serve-domain-cert/live/c1/fullchain.pem");
    expect(le.key).toBe("/etc/serve-domain-cert/live/c1/privkey.pem");
    const own = domainCertMount(ctx, { id: "c2", certPath: "/etc/serve/certs/c2/fullchain.pem", keyPath: "/etc/serve/certs/c2/privkey.pem" })!;
    expect(own.binds).toEqual(["/data/serve/certs/c2:/etc/serve-domain-cert/c2:ro"]);
    expect(domainCertMount(ctx, { id: "c3", certPath: null, keyPath: null })).toBeNull();
    expect(domainCertMount(ctx, { id: "c4", certPath: "/etc/letsencrypt/live/other/fullchain.pem", keyPath: "/etc/letsencrypt/live/other/privkey.pem" })).toBeNull();
  });

  it("accepts plain domain names only", () => {
    expect(hostnamePattern.test("db.shahriyar.dev")).toBe(true);
    for (const bad of ["db", "-db.example.com", "db..example.com", "DB.example.com", "*.example.com"]) expect(hostnamePattern.test(bad)).toBe(false);
  });
});
