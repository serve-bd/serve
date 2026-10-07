import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {}, schema: {} }));
const removeContainer = vi.fn(async () => {});
vi.mock("@/server/docker/client", () => ({ imageExists: vi.fn(), LABEL: {}, pullImage: vi.fn(), removeContainer }));
const inspect = vi.fn();
const serverOf = vi.fn();
// Reaching the replica's server means the promotion went past the guard: it stops there.
const getServer = vi.fn(async () => {
  throw new Error("past the guard");
});
vi.mock("@/server/servers/context", () => ({ serverOf, getServer }));

const { promoteReplica } = await import("@/server/databases/addons");

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
