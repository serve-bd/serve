import { describe, expect, it, vi } from "vitest";

// A database is down when its own container is, not when one of its read replicas is stopped:
// that one shows on the Read replicas list.

const state = vi.hoisted(() => ({ containers: [] as { Names: string[]; State: string; Status: string; Labels: Record<string, string> }[] }));
vi.mock("@/server/db", () => ({ db: {}, schema: {} }));
vi.mock("@/server/docker/client", () => ({ LABEL: { kind: "serve.kind", deployment: "serve.deployment" }, listServiceContainers: async () => state.containers }));
vi.mock("@/server/servers/context", () => ({ serverOf: async () => ({ docker: {} }), getServer: vi.fn() }));
vi.mock("@/server/metrics", () => ({ serverScope: vi.fn() }));
vi.mock("@/server/settings", () => ({ getSettings: vi.fn() }));
vi.mock("@/server/notify", () => ({ orgOfService: vi.fn() }));
vi.mock("@/server/queue", () => ({ enqueue: vi.fn() }));

const { containerCheck } = await import("@/server/monitoring/checks");
const database = { id: "d", type: "database" } as never;
const c = (name: string, state: string, kind?: string) => ({
  Names: [`/${name}`],
  State: state,
  Status: state === "running" ? "Up 1 minute (healthy)" : "Exited (0)",
  Labels: (kind ? { "serve.kind": kind } : {}) as Record<string, string>,
});

describe("the container check of a database", () => {
  it("passes with a stopped read replica", async () => {
    state.containers = [c("pg", "running"), c("pg-pooler", "running", "pooler"), c("pg-replica-3", "exited", "replica-3")];
    expect((await containerCheck(database)).ok).toBe(true);
  });

  it("fails when the database itself or its pooler is down", async () => {
    state.containers = [c("pg", "exited"), c("pg-replica-3", "running", "replica-3")];
    expect(await containerCheck(database)).toMatchObject({ ok: false, error: "pg is exited" });
    state.containers = [c("pg", "running"), c("pg-pooler", "exited", "pooler")];
    expect(await containerCheck(database)).toMatchObject({ ok: false, error: "pg-pooler is exited" });
  });
});
