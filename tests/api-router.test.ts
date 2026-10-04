import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const auth = {
  tokenId: "t1",
  userId: "u1",
  organizationId: "o1",
  permissions: new Set(["projects.view"]),
  admin: false,
  projectIds: null,
  canAccessProject: () => true,
  can: (p: string) => auth.permissions.has(p),
};
vi.mock("@/server/api-auth", () => ({
  authenticateToken: async (r: Request) =>
    r.headers.get("authorization") === "Bearer srv_ok" ? { auth } : { error: Response.json({ error: "Invalid or missing API token" }, { status: 401 }) },
}));
vi.mock("@/server/auth", () => ({ ForbiddenError: class extends Error {}, isInstanceAdmin: async () => false }));
const apiSettings = { apiEnabled: true, apiRateLimit: 0 };
vi.mock("@/server/settings", () => ({ getSettings: async () => apiSettings }));

const { createRouter, route, unwrap } = await import("@/server/api/router");
const { apiPrincipal } = await import("@/server/api/principal");

const handle = createRouter([
  route({
    method: "GET",
    path: "/things/{id}",
    tag: "T",
    summary: "Get",
    needs: ["projects.view"],
    handler: async ({ params }) => ({ id: params.id, as: apiPrincipal()?.tokenId }),
  }),
  route({
    method: "POST",
    path: "/things",
    tag: "T",
    summary: "Create",
    needs: ["services.manage"],
    body: z.object({ name: z.string() }),
    status: 201,
    handler: async ({ body }) => ({ name: body.name }),
  }),
  route({ method: "POST", path: "/fail", tag: "T", summary: "Fail", needs: [], body: z.object({}), handler: async () => unwrap({ ok: false, error: "Service not found." }) }),
]);

const req = (method: string, path: string, body?: unknown, token = "srv_ok") =>
  handle(new Request(`http://x/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }), path);

describe("API router", () => {
  it("matches paths and runs the handler as the token", async () => {
    const res = await req("GET", "/things/abc");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "abc", as: "t1" });
  });
  it("answers 404 for unknown paths and 405 for the wrong method", async () => {
    expect((await req("GET", "/nope")).status).toBe(404);
    const res = await req("DELETE", "/things/abc");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
  it("answers 400 for a path that is not valid percent-encoding", async () => {
    expect((await req("GET", "/things/%E0%A4%A")).status).toBe(400);
  });
  it("needs a valid token", async () => {
    expect((await req("GET", "/things/abc", undefined, "srv_bad")).status).toBe(401);
  });
  it("refuses a route the token lacks a permission for, naming it", async () => {
    const res = await req("POST", "/things", { name: "x" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ missing: ["services.manage"] });
  });
  it("validates the body", async () => {
    auth.permissions.add("services.manage");
    expect((await req("POST", "/things", { name: 1 })).status).toBe(400);
    const res = await req("POST", "/things", { name: "x" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ name: "x" });
    const bad = await handle(new Request("http://x/api/v1/things", { method: "POST", headers: { authorization: "Bearer srv_ok" }, body: "{" }), "/things");
    expect(bad.status).toBe(400);
  });
  it("turns action errors into HTTP statuses", async () => {
    const res = await req("POST", "/fail", {});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Service not found." });
  });

  it("answers 503 while the API is off, and 429 above the rate limit", async () => {
    const { resetRateLimits } = await import("@/server/api/rate-limit");
    resetRateLimits();
    const call = () => handle(new Request("http://x/api/v1/things/a", { headers: { authorization: "Bearer srv_ok" } }), "things/a");
    apiSettings.apiEnabled = false;
    expect((await call()).status).toBe(503);
    apiSettings.apiEnabled = true;
    apiSettings.apiRateLimit = 2;
    const first = await call();
    expect(first.status).toBe(200);
    expect(first.headers.get("x-ratelimit-remaining")).toBe("1");
    expect((await call()).status).toBe(200);
    const over = await call();
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBeTruthy();
    apiSettings.apiRateLimit = 0;
  });
});
