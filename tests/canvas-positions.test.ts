import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the services of the environment, and the data their deleted ones left there, keep a place.

const state = vi.hoisted(() => ({ saved: null as Record<string, unknown> | null }));
const tables = vi.hoisted(() => ({ service: { t: "service" }, keptDatabase: { t: "kd" }, keptVolume: { t: "kv" }, environment: { t: "env" } }));
vi.mock("server-only", () => ({}));
vi.mock("drizzle-orm", async (real) => ({
  ...(await real<typeof import("drizzle-orm")>()),
  sql: (_strings: TemplateStringsArray, ...values: unknown[]) => ({ values }),
}));
vi.mock("@/server/db", () => ({
  schema: new Proxy(tables, { get: (t, k: string) => (t as Record<string, unknown>)[k] ?? new Proxy({}, { get: () => ({}) }) }),
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: async () =>
          table === tables.service
            ? [{ id: "svc1" }]
            : table === tables.keptDatabase
              ? [{ id: "kd1" }]
              : table === tables.keptVolume
                ? [{ id: "kv1" }]
                : [{ id: "env1", projectId: "p" }],
      }),
    }),
    update: () => ({
      set: (v: { canvas: { values: unknown[] } }) => ({
        where: async () => {
          // The places merged in are the one JSON text among the statement's values.
          const json = v.canvas.values.find((x) => typeof x === "string" && x.startsWith("{"));
          state.saved = JSON.parse(String(json));
        },
      }),
    }),
  },
}));
vi.mock("@/server/auth", () => ({ requirePermission: async () => ({ org: { id: "org" }, user: { id: "u" } }) }));
vi.mock("@/server/services/access", () => ({ projectInOrg: async () => ({ id: "p" }), serviceInOrg: vi.fn() }));
vi.mock("@/server/activity", () => ({ logActivity: vi.fn() }));
vi.mock("@/server/queue", () => ({ enqueue: vi.fn() }));

const { saveCanvasPositions } = await import("@/server/actions/projects");

describe("saving canvas places", () => {
  beforeEach(() => {
    state.saved = null;
  });

  it("keeps services and kept data of the environment, and drops anything else", async () => {
    const at = { x: 10.4, y: 20 };
    expect((await saveCanvasPositions("env1", { svc1: at, "kept:database:kd1": at, "kept:volume:kv1": at, other: at, "kept:volume:elsewhere": at })).ok).toBe(true);
    expect(state.saved).toEqual({ svc1: { x: 10, y: 20 }, "kept:database:kd1": { x: 10, y: 20 }, "kept:volume:kv1": { x: 10, y: 20 } });
  });
});
