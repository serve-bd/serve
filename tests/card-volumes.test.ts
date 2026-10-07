import { describe, expect, it, vi } from "vitest";

// The volumes under each canvas card, per kind of service, with the sizes measured on its server.

vi.mock("@/server/deploy/containers", () => ({ volumeName: (slug: string, source: string) => `serve-${slug}-${source}` }));
vi.mock("@/server/databases/engines", () => ({ engines: { postgres: { dataPath: "/var/lib/postgresql/data" } } }));

const { cardVolumes } = await import("@/server/services/card-volumes");

const sizes = [
  { serverId: "s1", name: "serve-web-x1-uploads", composeProject: null, bytes: 2_400_000_000 },
  { serverId: "s2", name: "serve-web-x1-cache", composeProject: null, bytes: 5 },
  { serverId: "s1", name: "serve-db-x1-data", composeProject: null, bytes: 900 },
  { serverId: "s1", name: "legacy-pg", composeProject: null, bytes: 70 },
  { serverId: "s1", name: "shop-x1_db", composeProject: "shop-x1", bytes: 300 },
  { serverId: "s1", name: "shop-x1_cache", composeProject: "shop-x1", bytes: 0 },
  { serverId: "s1", name: "shop-x10_db", composeProject: "shop-x10", bytes: 1 },
  { serverId: "s2", name: "shop-x1_logs", composeProject: "shop-x1", bytes: 1 },
];

describe("volumes on canvas cards", () => {
  it("lists an app's named volumes, outside ones by their own name, and folders without a size", () => {
    const app = {
      type: "app",
      slug: "web-x1",
      serverId: "s1",
      database: null,
      runtime: {
        volumes: [
          { kind: "volume" as const, source: "uploads", mountPath: "/app/uploads" },
          { kind: "volume" as const, source: "cache", mountPath: "/cache" },
          { kind: "volume" as const, source: "theirs", mountPath: "/theirs", external: true },
          { kind: "bind" as const, source: "/srv/web", mountPath: "/srv" },
          { kind: "file" as const, source: "app.conf", mountPath: "/etc/app.conf" },
        ],
      },
    };
    expect(cardVolumes(app, sizes)).toEqual([
      { name: "serve-web-x1-uploads", mountPath: "/app/uploads", bytes: 2_400_000_000, bind: false },
      // Measured on another server only: not this one's size.
      { name: "serve-web-x1-cache", mountPath: "/cache", bytes: null, bind: false },
      { name: "theirs", mountPath: "/theirs", bytes: null, bind: false },
      { name: "/srv/web", mountPath: "/srv", bytes: null, bind: true },
    ]);
  });

  it("shows a database's own data volume at the engine's data path, then added volumes", () => {
    const db = {
      type: "database",
      slug: "db-x1",
      serverId: "s1",
      database: { engine: "postgres" } as never,
      runtime: {
        volumes: [
          { kind: "volume" as const, source: "data", mountPath: "/old" },
          { kind: "volume" as const, source: "wal", mountPath: "/wal" },
        ],
      },
    };
    expect(cardVolumes(db, sizes)).toEqual([
      { name: "serve-db-x1-data", mountPath: "/var/lib/postgresql/data", bytes: 900, bind: false },
      { name: "serve-db-x1-wal", mountPath: "/wal", bytes: null, bind: false },
    ]);
  });

  it("shows the data volume a database was started on, or its folder", () => {
    const base = { type: "database", slug: "db-x1", serverId: "s1", runtime: { volumes: [] } };
    expect(cardVolumes({ ...base, database: { engine: "postgres", dataVolume: "legacy-pg", dataMountPath: "/data" } as never }, sizes)).toEqual([
      { name: "legacy-pg", mountPath: "/data", bytes: 70, bind: false },
    ]);
    expect(cardVolumes({ ...base, database: { engine: "postgres", dataVolume: "/srv/pg" } as never }, sizes)).toEqual([
      { name: "/srv/pg", mountPath: "/var/lib/postgresql/data", bytes: null, bind: true },
    ]);
  });

  it("lists a stack's volumes by its compose project on its server, by name", () => {
    const stack = { type: "compose", slug: "shop-x1", serverId: "s1", database: null, runtime: { volumes: [] } };
    expect(cardVolumes(stack, sizes)).toEqual([
      { name: "shop-x1_cache", mountPath: null, bytes: 0, bind: false },
      { name: "shop-x1_db", mountPath: null, bytes: 300, bind: false },
    ]);
  });
});
