import { beforeEach, describe, expect, it, vi } from "vitest";

// A tiny stand-in for the database: rows per table, and the runs inserted.
const state = vi.hoisted(() => ({ tasks: [] as Record<string, unknown>[], runs: [] as Record<string, unknown>[], inserted: [] as Record<string, unknown>[] }));

vi.mock("drizzle-orm", () => ({
  and: (...c: unknown[]) => ({ and: c }),
  eq: (col: unknown, value: unknown) => ({ eq: [col, value] }),
  lt: () => ({}),
  desc: () => ({}),
  notInArray: () => ({}),
}));
vi.mock("@/server/db", () => {
  const schema = {
    scheduledTask: { name: "scheduledTask", enabled: "enabled", id: "id" },
    taskRun: { name: "taskRun", id: "id", taskId: "taskId", status: "status", startedAt: "startedAt" },
    service: { name: "service", id: "id", status: "status", runtime: "runtime" },
  };
  const rowsOf = (table: { name: string }, where: unknown) => {
    if (table.name === "scheduledTask") return state.tasks;
    if (table.name === "taskRun") {
      const taskId = (JSON.stringify(where).match(/"taskId","([^"]+)"/) ?? [])[1];
      return state.runs.filter((r) => r.taskId === taskId && r.status === "running");
    }
    return [];
  };
  const select = () => ({
    from: (table: { name: string }) => ({
      where: (where: unknown) => {
        const rows = rowsOf(table, where);
        return Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows.slice(0, 1)) });
      },
    }),
  });
  const db = {
    select,
    insert: () => ({ values: async (v: Record<string, unknown>) => void state.inserted.push(v) }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  };
  return { db, schema };
});
vi.mock("@/server/queue", () => ({ enqueue: vi.fn(async () => "job") }));
vi.mock("@/server/notify", () => ({ notify: vi.fn(), orgOfService: vi.fn() }));
vi.mock("@/server/services/exec", () => ({ execCommand: vi.fn(), getService: vi.fn(), pickContainer: vi.fn() }));
vi.mock("@/server/settings", () => ({ getSetting: vi.fn(async () => "UTC") }));

import { scheduleTasks } from "@/server/services/tasks";

describe("scheduled tasks", () => {
  beforeEach(() => {
    state.inserted = [];
    state.runs = [];
  });

  it("starts a run when the schedule fires", async () => {
    state.tasks = [{ id: "t1", serviceId: "s1", command: "echo", schedule: "* * * * *", enabled: true }];
    await scheduleTasks();
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({ taskId: "t1", trigger: "schedule" });
  });

  it("skips a run while the previous one still runs, instead of queueing one every time", async () => {
    state.tasks = [{ id: "t2", serviceId: "s1", command: "sleep 3600", schedule: "* * * * *", enabled: true }];
    state.runs = [{ id: "r1", taskId: "t2", status: "running" }];
    await scheduleTasks();
    expect(state.inserted).toHaveLength(0);
  });
});
