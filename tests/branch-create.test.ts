import { beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for the database: the branches of one service, an advisory lock per key (held until
// the transaction ends) and the unique index on (service, name).
const state = vi.hoisted(() => ({ branches: [] as Record<string, unknown>[], locks: new Map<string, Promise<void>>() }));

vi.mock("@/server/db", () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const client = (release: (() => void)[]) => ({
    execute: async (q: { queryChunks?: unknown[] }) => {
      const key = String((q.queryChunks ?? []).find((c) => typeof c === "string"));
      while (state.locks.has(key)) await state.locks.get(key);
      let done!: () => void;
      state.locks.set(
        key,
        new Promise<void>((r) => {
          done = r;
        }),
      );
      release.push(() => {
        state.locks.delete(key);
        done();
      });
    },
    select: () => ({ from: () => ({ where: async () => (await tick(), state.branches.map((b) => ({ ...b }))) }) }),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          await tick();
          if (state.branches.some((b) => b.serviceId === v.serviceId && b.name === v.name))
            throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
          state.branches.push(v);
          return [v];
        },
      }),
    }),
  });
  const db = {
    ...client([]),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      const release: (() => void)[] = [];
      try {
        return await fn(client(release));
      } finally {
        for (const r of release) r();
      }
    },
  };
  return { db, schema: { databaseBranch: {}, databaseUser: {} } };
});
vi.mock("drizzle-orm", async (actual) => ({ ...(await actual<typeof import("drizzle-orm")>()), eq: () => ({}), and: () => ({}) }));
vi.mock("@/server/crypto", () => ({ encrypt: (s: string) => s, decrypt: (s: string) => s }));
vi.mock("@/server/queue", () => ({ enqueue: vi.fn() }));
vi.mock("@/server/activity", () => ({ logActivity: vi.fn() }));
vi.mock("@/server/servers/context", () => ({ serverOf: vi.fn() }));
vi.mock("@/server/services/exec", () => ({ execCommand: vi.fn() }));
vi.mock("@/server/databases/container", () => ({ databaseContainer: vi.fn() }));

import { BranchNameError, createBranch } from "@/server/databases/branches";

const service = (engine: string) =>
  ({ id: "s1", type: "database", status: "stopped", name: "db", database: { engine, database: engine === "postgres" ? "app" : "0", password: "pw" } }) as unknown as Parameters<
    typeof createBranch
  >[0];

describe("creating branches at the same moment", () => {
  beforeEach(() => {
    state.branches = [];
    state.locks.clear();
  });

  it("gives Redis and Valkey branches made together different database numbers", async () => {
    const made = await Promise.all(["a", "b", "c"].map((name) => createBranch(service("redis"), name)));
    expect(made.map((b) => b.database).sort()).toEqual(["1", "2", "3"]);
  });

  it("says the name is taken when two branches of one name are made together", async () => {
    const results = await Promise.allSettled([createBranch(service("postgres"), "x"), createBranch(service("postgres"), "x")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(BranchNameError);
    expect(failed.reason.message).toBe("A branch named x exists already.");
  });
});
