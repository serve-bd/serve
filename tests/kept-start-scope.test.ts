import { describe, expect, it, vi } from "vitest";

// A member limited to some projects cannot start a database on data another project left: its
// volume and password stay out of reach.

const tables = vi.hoisted(() => ({ keptDatabase: { t: "kd" }, environment: { t: "env" } }));
const state = vi.hoisted(() => ({ keptProject: "pB" as string | null }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => ({
  schema: new Proxy(tables, { get: (t, k: string) => (t as Record<string, unknown>)[k] ?? new Proxy({}, { get: () => ({}) }) }),
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => (table === tables.keptDatabase ? [{ id: "k1", projectId: state.keptProject, engine: "postgres" }] : table === tables.environment ? [{ id: "e1" }] : []),
      }),
    }),
  },
}));
vi.mock("@/server/auth", () => ({
  requirePermission: async () => ({ org: { id: "org" }, user: { id: "u" }, projectIds: ["pA"], canAccessProject: (id: string) => id === "pA" }),
  ForbiddenError: class extends Error {},
}));
vi.mock("@/server/services/access", () => ({ projectInOrg: async () => ({ id: "pA" }), serviceInOrg: vi.fn() }));
vi.mock("@/server/activity", () => ({ logActivity: vi.fn() }));
vi.mock("@/server/queue", () => ({ enqueue: vi.fn() }));

const { createDatabaseService } = await import("@/server/actions/services");
const start = () => createDatabaseService({ projectId: "pA", environmentId: "e1", name: "copy", engine: "postgres", keptId: "k1" } as never);

describe("starting a database on kept data", () => {
  it("is refused for data of a project the member cannot reach", async () => {
    state.keptProject = "pB";
    expect(await start()).toEqual({ ok: false, error: "That kept data is gone." });
  });

  it("is refused for old data with no project, which only members of every project reach", async () => {
    state.keptProject = null;
    expect(await start()).toEqual({ ok: false, error: "That kept data is gone." });
  });
});
