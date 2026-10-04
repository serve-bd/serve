import { describe, expect, it, vi } from "vitest";

let rows: unknown[] = [];
const chain = { from: () => chain, innerJoin: () => chain, where: async () => rows };
vi.mock("@/server/db", () => ({ db: { select: () => chain }, schema: { deployment: {}, service: {} } }));
vi.mock("drizzle-orm", async (orig) => ({ ...(await orig<typeof import("drizzle-orm")>()), eq: () => null }));
const jobs: { type: string; payload: unknown; opts: unknown }[] = [];
vi.mock("@/server/queue", () => ({ enqueue: async (type: string, payload: unknown, opts: unknown) => void jobs.push({ type, payload, opts }) }));

const { queueCommitStatus } = await import("@/server/git/commit-status");

describe("queueing reports", () => {
  it("queues the state the deployment has now, one service's reports in order", async () => {
    rows = [{ status: "building", serviceId: "svc1", source: { type: "git", repository: "r", branch: "main", credentialId: "c1" } }];
    await queueCommitStatus("dep1");
    expect(jobs).toEqual([{ type: "commit.status", payload: { deploymentId: "dep1", status: "building" }, opts: { concurrencyKey: "commit-status:svc1", maxAttempts: 3 } }]);
  });
  it("queues nothing for services that cannot report", async () => {
    jobs.length = 0;
    rows = [{ status: "success", serviceId: "svc1", source: { type: "git", repository: "r", branch: "main", credentialId: null } }];
    await queueCommitStatus("dep1");
    rows = [{ status: "success", serviceId: "svc1", source: { type: "image", image: "nginx" } }];
    await queueCommitStatus("dep1");
    rows = [];
    await queueCommitStatus("dep1");
    expect(jobs).toHaveLength(0);
  });
  it("never throws into the deploy", async () => {
    chain.where = async () => {
      throw new Error("database down");
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(queueCommitStatus("dep1")).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
