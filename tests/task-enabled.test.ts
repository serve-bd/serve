import { beforeEach, describe, expect, it, vi } from "vitest";

// Editing a scheduled task (dashboard or PATCH /tasks/{id}) keeps it paused unless enabled is sent.

const state = vi.hoisted(() => ({ updates: [] as Record<string, unknown>[], inserts: [] as Record<string, unknown>[] }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => {
  const schema = new Proxy({}, { get: () => new Proxy({}, { get: (_t, col) => col }) });
  const task = { id: "t1", serviceId: "s1", enabled: false };
  const db = {
    select: () => ({ from: () => ({ where: async () => [task] }) }),
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => void state.updates.push(v) }) }),
    insert: () => ({ values: async (v: Record<string, unknown>) => void state.inserts.push(v) }),
  };
  return { db, schema };
});
vi.mock("@/server/auth", () => ({
  requirePermission: async () => ({ isAdmin: true, isInstanceAdmin: false, org: { id: "o1" }, user: { id: "u1" } }),
  ForbiddenError: class extends Error {},
}));
vi.mock("@/server/activity", () => ({ logActivity: async () => {} }));
vi.mock("@/server/services/access", () => ({ serviceInOrg: async () => ({ service: { id: "s1", name: "web", projectId: "p1", runtime: {}, compose: null } }) }));
vi.mock("@/server/security", () => ({ serviceHasHostAccess: () => false }));

const { saveTask } = await import("@/server/actions/tasks");

const input = { name: "cleanup", schedule: "0 3 * * *", command: "rm -rf /tmp/cache", timeoutSeconds: 600 };

describe("saving a scheduled task", () => {
  beforeEach(() => {
    state.updates = [];
    state.inserts = [];
  });

  it("leaves a paused task paused when enabled is not sent", async () => {
    expect(await saveTask("s1", "t1", input)).toMatchObject({ ok: true });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].enabled).toBeUndefined();
  });

  it("changes enabled when it is sent", async () => {
    await saveTask("s1", "t1", { ...input, enabled: true });
    expect(state.updates[0].enabled).toBe(true);
  });

  it("turns a new task on unless told otherwise", async () => {
    await saveTask("s1", null, input);
    await saveTask("s1", null, { ...input, enabled: false });
    expect(state.inserts.map((v) => v.enabled)).toEqual([true, false]);
  });
});
