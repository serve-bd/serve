import { describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-api-spec";
process.env.DATABASE_URL ??= "postgres://x@localhost/x";

vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => ({ db: {}, schema: new Proxy({}, { get: () => new Proxy({}, { get: () => ({}) }) }) }));

const { apiRoutes, openApiDocument } = await import("@/server/api");
const { PERMISSIONS } = await import("@/lib/permissions");

describe("API routes", () => {
  it("are unique and each names what it needs", () => {
    const keys = apiRoutes.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of apiRoutes) for (const n of r.needs) expect([...PERMISSIONS, "admin", "instance"]).toContain(n);
    // Anything that changes something needs a permission, except the token's own revocation.
    for (const r of apiRoutes.filter((x) => x.method !== "GET" && !x.path.startsWith("/tokens"))) expect(r.needs.length, `${r.method} ${r.path}`).toBeGreaterThan(0);
  });
  it("cover the main resources", () => {
    expect(apiRoutes.length).toBeGreaterThan(100);
  });
  it("build an OpenAPI document with unique operation ids", () => {
    const doc = openApiDocument("https://serve.example.com");
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0].url).toBe("https://serve.example.com/api/v1");
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p) as { operationId: string; tags: string[] }[]);
    expect(ops.length).toBe(apiRoutes.length);
    expect(new Set(ops.map((o) => o.operationId)).size).toBe(ops.length);
    const tags = new Set<string>(doc.tags.map((t) => t.name));
    for (const o of ops) expect(tags.has(o.tags[0])).toBe(true);
  });
});
