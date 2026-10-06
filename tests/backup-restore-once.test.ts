import { beforeEach, describe, expect, it, vi } from "vitest";

// A restore is refused while another one of the same service is queued or running.

const state = vi.hoisted(() => ({
  backups: [] as { id: string; serviceId: string; status: string; restoreStatus: string | null }[],
  enqueued: [] as string[],
}));
vi.mock("server-only", () => ({}));
vi.mock("drizzle-orm", async (actual) => {
  const real = await actual<typeof import("drizzle-orm")>();
  return { ...real, eq: (col: unknown, value: unknown) => ({ eq: [col, value] }), and: (...c: unknown[]) => ({ and: c }) };
});
vi.mock("@/server/db", () => {
  // Columns are their names, so conditions can be read back.
  const schema = new Proxy({}, { get: () => new Proxy({}, { get: (_t, col) => col }) });
  const conds = (w: unknown): [string, unknown][] => {
    const o = w as { eq?: [string, unknown]; and?: unknown[] };
    return o.eq ? [o.eq] : (o.and ?? []).flatMap(conds);
  };
  const matching = (w: unknown) => state.backups.filter((b) => conds(w).every(([k, v]) => (b as Record<string, unknown>)[k] === v));
  const client = {
    execute: async () => {},
    select: () => ({ from: () => ({ where: (w: unknown) => Object.assign(Promise.resolve(matching(w)), { limit: async () => matching(w).slice(0, 1) }) }) }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async (w: unknown) => {
          for (const b of matching(w)) Object.assign(b, v);
        },
      }),
    }),
  };
  return { db: { ...client, transaction: async <T>(fn: (tx: typeof client) => Promise<T>) => fn(client) }, schema };
});
vi.mock("@/server/auth", () => ({ requirePermission: async () => ({ isAdmin: true, org: { id: "org" }, user: { id: "u" } }), ForbiddenError: class extends Error {} }));
vi.mock("@/server/activity", () => ({ logActivity: async () => {} }));
vi.mock("@/server/queue", () => ({ enqueue: async (type: string) => void state.enqueued.push(type) }));
vi.mock("@/server/services/access", () => ({ serviceInOrg: async () => ({ service: { id: "s", name: "db", projectId: "p", type: "database", status: "running" } }) }));

import { restoreFromBackup } from "@/server/actions/services";

describe("restoring a backup", () => {
  beforeEach(() => {
    state.backups = [
      { id: "b1", serviceId: "s", status: "success", restoreStatus: null },
      { id: "b2", serviceId: "s", status: "success", restoreStatus: null },
      { id: "o1", serviceId: "other", status: "success", restoreStatus: "running" },
    ];
    state.enqueued = [];
  });

  it("queues a restore and marks the backup restoring", async () => {
    expect(await restoreFromBackup("b1")).toMatchObject({ ok: true });
    expect(state.backups[0].restoreStatus).toBe("running");
    // Every restore goes through the safety backup (put back if the restore fails).
    expect(state.enqueued).toEqual(["backup.import"]);
  });

  it("refuses the same backup or another one while a restore of the service is queued or running", async () => {
    await restoreFromBackup("b1");
    for (const id of ["b1", "b2"]) {
      const r = await restoreFromBackup(id, { backupFirst: true });
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/already queued or running/) });
    }
    expect(state.enqueued).toEqual(["backup.import"]);
    expect(state.backups[1].restoreStatus).toBeNull();
  });

  it("restores again once the restore finished", async () => {
    state.backups[0].restoreStatus = "success";
    expect(await restoreFromBackup("b1")).toMatchObject({ ok: true });
  });
});
