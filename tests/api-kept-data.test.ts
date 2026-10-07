import { beforeEach, describe, expect, it, vi } from "vitest";

// Kept data in the API: listed per environment for tokens that view projects, deleted with
// services.manage, never another organization's or another project's, never a password.

const state = vi.hoisted(() => ({
  auth: null as null | Record<string, unknown>,
  tables: {} as Record<string, Record<string, unknown>[]>,
  calls: [] as unknown[][],
  result: { ok: true, data: null } as { ok: boolean; data?: unknown; error?: string },
}));

vi.mock("server-only", () => ({}));
vi.mock("drizzle-orm", async (actual) => {
  const real = await actual<typeof import("drizzle-orm")>();
  return { ...real, eq: (col: unknown, value: unknown) => ({ eq: [col, value] }), and: (...c: unknown[]) => ({ and: c.filter(Boolean) }) };
});
vi.mock("@/server/db", () => {
  const schema = new Proxy({}, { get: (_t, table) => new Proxy({ __table: table }, { get: (t, col) => (col === "__table" ? t.__table : `${String(table)}.${String(col)}`) }) });
  const conds = (w: unknown): [string, unknown][] => {
    const o = (w ?? {}) as { eq?: [string, unknown]; and?: unknown[] };
    return o.eq ? [o.eq] : (o.and ?? []).flatMap(conds);
  };
  const db = {
    select: () => ({
      from: (t: { __table: string }) => ({
        where: async (w: unknown) => (state.tables[t.__table] ?? []).filter((row) => conds(w).every(([col, v]) => row[col.split(".")[1]] === v)),
      }),
    }),
  };
  return { db, schema };
});
vi.mock("@/server/api-auth", () => ({
  authenticateToken: async () => (state.auth ? { auth: state.auth } : { error: Response.json({ error: "Invalid or missing API token" }, { status: 401 }) }),
}));
vi.mock("@/server/auth", () => ({ ForbiddenError: class extends Error {}, isInstanceAdmin: async () => false }));
vi.mock("@/server/settings", () => ({ getSettings: async () => ({ apiEnabled: true, apiRateLimit: 0 }), getSetting: async () => null }));
vi.mock("@/server/api/data", async (actual) => {
  const real = await actual<typeof import("@/server/api/data")>();
  const { ApiError } = await import("@/server/api/router");
  return {
    ...real,
    loadEnvironment: async (auth: { organizationId: string; canAccessProject: (id: string) => boolean }, id: string) => {
      const env = { e1: { projectId: "p1", org: "o1" }, e2: { projectId: "p2", org: "o2" } }[id];
      if (!env || env.org !== auth.organizationId || !auth.canAccessProject(env.projectId)) throw new ApiError(404, "Environment not found");
      return { environment: { id }, project: { id: env.projectId, organizationId: env.org } };
    },
  };
});
vi.mock("@/server/services/kept-data", () => ({
  environmentKept: async (environmentId: string, organizationId: string) => {
    state.calls.push(["environmentKept", environmentId, organizationId]);
    return [{ kind: "database", id: "k2", volume: "serve-db-x1-data", serviceName: "db", serviceType: "database", engine: "postgres", bytes: 100 }];
  },
}));
vi.mock("@/server/actions/kept-data", () => ({
  deleteKeptData: async (...args: unknown[]) => {
    state.calls.push(["deleteKeptData", ...args]);
    return state.result;
  },
}));

const { createRouter } = await import("@/server/api/router");
const { projectRoutes } = await import("@/server/api/routes/projects");
const handle = createRouter(projectRoutes);
const call = (method: string, path: string) => handle(new Request(`http://x/api/v1${path}`, { method, headers: { authorization: "Bearer srv_x" } }), path);

function token(permissions: string[], opts: { org?: string; projects?: string[] | null } = {}) {
  const set = new Set(permissions);
  state.auth = {
    tokenId: "tok1",
    userId: "u1",
    organizationId: opts.org ?? "o1",
    permissions: set,
    admin: false,
    projectIds: opts.projects ?? null,
    canAccessProject: (id: string) => !opts.projects || opts.projects.includes(id),
    can: (p: string) => set.has(p),
  };
}

beforeEach(() => {
  state.calls = [];
  state.result = { ok: true, data: null };
  state.tables = {
    keptDatabase: [
      { id: "k2", organizationId: "o1", projectId: "p1", password: "secret" },
      { id: "old", organizationId: "o1", projectId: null, password: "secret" },
      { id: "theirs", organizationId: "o2", projectId: "p2", password: "secret" },
    ],
    keptVolume: [{ id: "k1", organizationId: "o1", projectId: "p1" }],
  };
});

describe("kept data in the API", () => {
  it("lists an environment's kept data with projects.view, without passwords", async () => {
    token(["projects.view"]);
    const res = await call("GET", "/environments/e1/kept-data");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keptData).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(state.calls).toEqual([["environmentKept", "e1", "o1"]]);
  });

  it("does not list another organization's environment", async () => {
    token(["projects.view"]);
    expect((await call("GET", "/environments/e2/kept-data")).status).toBe(404);
    expect(state.calls).toEqual([]);
  });

  it("deletes with services.manage only", async () => {
    token(["projects.view"]);
    expect((await call("DELETE", "/kept-data/volume/k1")).status).toBe(403);
    token(["services.manage"]);
    const res = await call("DELETE", "/kept-data/volume/k1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(state.calls).toEqual([["deleteKeptData", "volume", "k1"]]);
  });

  it("passes the note on when Serve only forgets the data", async () => {
    token(["services.manage"]);
    state.result = { ok: true, data: { note: "Serve forgot this data. The folder stays at /srv/pg on the server." } };
    expect(await (await call("DELETE", "/kept-data/database/k2")).json()).toEqual({ ok: true, note: expect.stringContaining("/srv/pg") });
  });

  it("never reaches another organization's data, an unknown kind or another project's", async () => {
    token(["services.manage"]);
    expect((await call("DELETE", "/kept-data/database/theirs")).status).toBe(404);
    expect((await call("DELETE", "/kept-data/files/k1")).status).toBe(404);
    token(["services.manage"], { projects: ["p9"] });
    expect((await call("DELETE", "/kept-data/volume/k1")).status).toBe(404);
    // Data kept before it had a project belongs to the whole organization.
    expect((await call("DELETE", "/kept-data/database/old")).status).toBe(404);
    expect(state.calls).toEqual([]);
  });

  it("answers a volume in use as a conflict", async () => {
    token(["services.manage"]);
    state.result = { ok: false, error: "serve-web-x1-uploads is already in use by a container. Remove that container first. Nothing was deleted." };
    expect((await call("DELETE", "/kept-data/volume/k1")).status).toBe(409);
  });
});
