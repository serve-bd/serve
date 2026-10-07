import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {}, schema: {} }));
const removeContainer = vi.fn(async () => {});
vi.mock("@/server/docker/client", () => ({
  imageExists: vi.fn(),
  LABEL: { service: "serve.service", kind: "serve.kind", managed: "serve.managed" },
  pullImage: vi.fn(),
  removeContainer,
}));
const inspect = vi.fn();
const serverOf = vi.fn();
// Reaching the replica's server means the promotion went past the guard: it stops there.
const getServer = vi.fn(async (_id: string): Promise<unknown> => {
  throw new Error("past the guard");
});
vi.mock("@/server/servers/context", () => ({ serverOf, getServer }));

const { promoteReplica, startReplica, startReplicas } = await import("@/server/databases/addons");

const service = {
  id: "svc",
  slug: "db-main",
  name: "main-db",
  serverId: "s1",
  database: { engine: "postgres", replica: { enabled: true, instances: [{ id: "r1", serverId: "s2" }] } },
} as never;

describe("promoting a read replica", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverOf.mockResolvedValue({ row: { name: "home" }, docker: { getContainer: () => ({ inspect }) } });
  });

  it("stops when the old database is still there, before touching the replica", async () => {
    inspect.mockResolvedValue({ State: { Running: false } });
    await expect(promoteReplica(service, "r1")).rejects.toThrow(/could not be removed on home/);
    expect(getServer).not.toHaveBeenCalled();
  });

  it("stops when the old server cannot say whether it is gone", async () => {
    inspect.mockRejectedValue(Object.assign(new Error("socket hang up"), { statusCode: undefined }));
    await expect(promoteReplica(service, "r1")).rejects.toThrow(/Could not check that main-db stopped/);
    expect(getServer).not.toHaveBeenCalled();
  });

  it("goes on once the old database is gone", async () => {
    inspect.mockRejectedValue(Object.assign(new Error("no such container"), { statusCode: 404 }));
    await expect(promoteReplica(service, "r1")).rejects.toThrow("past the guard");
    expect(removeContainer).toHaveBeenCalledWith("db-main", 30, expect.anything());
  });

  it("goes on without stopping when the old server is lost", async () => {
    serverOf.mockRejectedValue(new Error("unreachable"));
    await expect(promoteReplica(service, "r1")).rejects.toThrow("past the guard");
    expect(removeContainer).not.toHaveBeenCalled();
  });
});

describe("starting a stopped read replica", () => {
  const start = vi.fn();
  const db2 = {
    ...(service as object),
    database: {
      engine: "postgres",
      replica: {
        enabled: true,
        instances: [
          { id: "2", serverId: "far" },
          { id: "3", serverId: "s1" },
        ],
      },
    },
  } as never;
  beforeEach(() => {
    vi.clearAllMocks();
    start.mockReset().mockResolvedValue(undefined);
    getServer.mockImplementation(async (id: string) => {
      if (id === "far") throw new Error("far does not answer");
      return { docker: { getContainer: () => ({ inspect: async () => ({ Config: { Labels: { "serve.service": "svc" } } }), start }) } };
    });
  });

  it("starts its container, and is fine with one already running", async () => {
    await startReplica(db2, "3");
    expect(start).toHaveBeenCalledTimes(1);
    start.mockRejectedValueOnce(Object.assign(new Error("already started"), { statusCode: 304 }));
    await expect(startReplica(db2, "3")).resolves.toBeUndefined();
  });

  it("starts the others when one server does not answer, and names the one that failed", async () => {
    expect(await startReplicas(db2)).toEqual(["replica 2: far does not answer"]);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("refuses a replica that is gone", async () => {
    await expect(startReplica(db2, "9")).rejects.toThrow("That replica is gone.");
  });
});
