import { beforeEach, describe, expect, it, vi } from "vitest";

// Volume sizes: each reachable server's `docker system df`, saved per volume; volumes gone from a
// server are forgotten; a server that fails keeps its sizes and does not stop the others.

const state = vi.hoisted(() => ({
  upserts: [] as { rows: Record<string, unknown>[] }[],
  deletes: [] as unknown[],
  df: {} as Record<string, unknown>,
}));
vi.mock("@/server/db", () => ({
  db: {
    select: () => ({
      from: async () => [
        { id: "local", name: "This server", isLocal: true, status: "ready" },
        { id: "s2", name: "eu-1", isLocal: false, status: "ready" },
        { id: "s3", name: "down", isLocal: false, status: "unreachable" },
      ],
    }),
    insert: () => ({ values: (rows: Record<string, unknown>[]) => ({ onConflictDoUpdate: async () => void state.upserts.push({ rows }) }) }),
    delete: () => ({ where: async (w: unknown) => void state.deletes.push(w) }),
  },
  schema: { server: {}, volumeSize: {} },
}));
vi.mock("drizzle-orm", () => ({
  sql: (s: TemplateStringsArray) => s.join(""),
  eq: (_c: unknown, v: unknown) => ({ eq: v }),
  notInArray: (_c: unknown, v: unknown) => ({ notIn: v }),
  and: (...parts: unknown[]) => parts.filter(Boolean),
}));
vi.mock("@/server/monitoring/containers", () => ({ withTimeout: (p: Promise<unknown>) => p }));
vi.mock("@/server/servers/context", () => ({
  getServer: async (id: string) => ({
    docker: {
      df: async () => {
        const r = state.df[id];
        if (r instanceof Error) throw r;
        if (r === undefined) throw new Error(`asked ${id}`);
        return r;
      },
    },
  }),
}));

const { measureVolumeSizes } = await import("@/server/docker/volume-sizes");

describe("measuring volume sizes", () => {
  beforeEach(() => {
    state.upserts = [];
    state.deletes = [];
  });

  it("saves known sizes with their compose project and forgets volumes gone from the server", async () => {
    state.df = {
      local: {
        Volumes: [
          { Name: "serve-web-x1-uploads", Labels: null, UsageData: { Size: 2_400_000_000 } },
          { Name: "shop-x1_db", Labels: { "com.docker.compose.project": "shop-x1" }, UsageData: { Size: 0 } },
          { Name: "not-measured", Labels: {}, UsageData: { Size: -1 } },
        ],
      },
      s2: { Volumes: null },
    };
    await measureVolumeSizes();
    const local = state.upserts.find((u) => u.rows[0].serverId === "local")!;
    expect(local.rows).toEqual([
      expect.objectContaining({ serverId: "local", name: "serve-web-x1-uploads", composeProject: null, bytes: 2_400_000_000 }),
      expect.objectContaining({ serverId: "local", name: "shop-x1_db", composeProject: "shop-x1", bytes: 0 }),
    ]);
    // The unmeasured volume is still there: its last size is kept, not deleted.
    expect(state.deletes).toContainEqual([{ eq: "local" }, { notIn: ["serve-web-x1-uploads", "shop-x1_db", "not-measured"] }]);
    // A server with no volumes left forgets all of its sizes.
    expect(state.deletes).toContainEqual([{ eq: "s2" }]);
  });

  it("keeps a server's sizes when its answer has no volume list at all", async () => {
    state.df = { local: {}, s2: { Volumes: [] } };
    await measureVolumeSizes();
    expect(state.deletes).not.toContainEqual(expect.arrayContaining([{ eq: "local" }]));
    expect(state.deletes).toContainEqual([{ eq: "s2" }]);
  });

  it("goes on past a server that fails, then reports it", async () => {
    state.df = { local: new Error("Cannot connect to the Docker daemon"), s2: { Volumes: [{ Name: "v", UsageData: { Size: 10 } }] } };
    await expect(measureVolumeSizes()).rejects.toThrow("This server: Cannot connect to the Docker daemon");
    expect(state.upserts).toEqual([{ rows: [expect.objectContaining({ serverId: "s2", name: "v", bytes: 10 })] }]);
    expect(state.deletes).toEqual([[{ eq: "s2" }, { notIn: ["v"] }]]);
  });
});
