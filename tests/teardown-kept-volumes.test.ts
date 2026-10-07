import { beforeEach, describe, expect, it, vi } from "vitest";

// Deleting apps and stacks with their data kept remembers their volumes, so the canvas can show
// them; not when the volumes go too, not when only Serve forgets the services, not for a service
// that never ran.

const state = vi.hoisted(() => ({
  inserts: [] as { table: unknown; rows: Record<string, unknown>[] }[],
  activity: [] as { action: string; message: string }[],
  listed: [] as string[],
  listError: null as Error | null,
  volumes: [{ Name: "shop-x1_db" }, { Name: "shop-x1_cache" }],
}));
const tables = vi.hoisted(() => ({
  service: { t: "service" },
  domain: { t: "domain" },
  deployment: { t: "deployment" },
  project: { t: "project" },
  keptDatabase: { t: "keptDatabase" },
  keptVolume: { t: "keptVolume" },
}));
vi.mock("@/server/db", () => ({
  db: {
    select: () => ({ from: (table: unknown) => ({ where: async () => (table === tables.project ? [{ id: "p1", organizationId: "o1" }] : []) }) }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    delete: () => ({ where: async () => {} }),
    insert: (table: unknown) => ({ values: async (rows: Record<string, unknown>[]) => void state.inserts.push({ table, rows }) }),
  },
  schema: new Proxy(tables, { get: (t, k: string) => (t as Record<string, unknown>)[k] ?? {} }),
  sql: { notify: async () => {} },
}));
vi.mock("@/server/queue", () => ({ CANCEL_CHANNEL: "c", enqueue: vi.fn() }));
vi.mock("@/server/databases/branches", () => ({ removePreviewBranches: async () => {} }));
vi.mock("@/server/deploy/distribution", () => ({ runServerIds: (id: string, d: { servers?: string[] } | null) => [id, ...(d?.servers ?? [])] }));
vi.mock("@/server/deploy/containers", () => ({ volumeName: (slug: string, source: string) => `serve-${slug}-${source}` }));
vi.mock("@/server/git/repo-webhooks", () => ({ removeRepoWebhook: async () => {} }));
vi.mock("@/server/activity", () => ({ logActivity: async (e: { action: string; message: string }) => void state.activity.push(e) }));
vi.mock("@/server/monitoring/containers", () => ({ withTimeout: (p: Promise<unknown>) => p }));
vi.mock("@/server/servers/context", () => ({
  getServer: async () => ({
    docker: {
      listVolumes: async (opts: { filters: { label: string[] } }) => {
        if (state.listError) throw state.listError;
        state.listed.push(...opts.filters.label);
        return { Volumes: state.volumes };
      },
    },
  }),
}));

const { teardownServices } = await import("@/server/services/teardown");

const base = { projectId: "p1", environmentId: "e1", serverId: "s1", parentServiceId: null, database: null, source: null, distribution: null, currentDeploymentId: "dep1" };
const app = {
  ...base,
  id: "a1",
  name: "web",
  slug: "web-x1",
  type: "app",
  runtime: {
    volumes: [
      { kind: "volume", source: "uploads", mountPath: "/app/uploads" },
      { kind: "volume", source: "theirs", mountPath: "/theirs", external: true },
      { kind: "bind", source: "/srv/web", mountPath: "/srv" },
      { kind: "file", source: "app.conf", mountPath: "/etc/app.conf" },
    ],
  },
} as never;
const stack = { ...base, id: "c1", name: "shop", slug: "shop-x1", type: "compose", runtime: { volumes: [] } } as never;

const kept = () => state.inserts.filter((i) => i.table === tables.keptVolume).flatMap((i) => i.rows);

describe("kept volumes on delete", () => {
  beforeEach(() => {
    state.inserts = [];
    state.activity = [];
    state.listed = [];
    state.listError = null;
  });

  it("records an app's own named volumes, not external ones, binds or files", async () => {
    await teardownServices([app], false);
    expect(kept()).toEqual([
      expect.objectContaining({
        organizationId: "o1",
        serverId: "s1",
        projectId: "p1",
        environmentId: "e1",
        serviceName: "web",
        serviceType: "app",
        volume: "serve-web-x1-uploads",
        mountPath: "/app/uploads",
        owned: true,
      }),
    ]);
  });

  it("records the volumes on each server an app ran on", async () => {
    await teardownServices([{ ...(app as object), distribution: { servers: ["s2"] } } as never], false);
    expect(kept().map((r) => r.serverId)).toEqual(["s1", "s2"]);
  });

  it("records a stack's volumes by its compose project label", async () => {
    await teardownServices([stack], false);
    expect(state.listed).toEqual(["com.docker.compose.project=shop-x1"]);
    expect(kept()).toEqual([
      expect.objectContaining({ serviceType: "compose", volume: "shop-x1_db", mountPath: null, owned: true, environmentId: "e1" }),
      expect.objectContaining({ serviceType: "compose", volume: "shop-x1_cache" }),
    ]);
  });

  it("reports a stack whose server cannot list its volumes, and records nothing for it", async () => {
    state.listError = new Error("connect ETIMEDOUT");
    const warning = await teardownServices([stack], false);
    expect(kept()).toEqual([]);
    expect(warning).toContain("Volumes of shop");
    expect(warning).toContain("connect ETIMEDOUT");
  });

  it("records nothing when the volumes are deleted too", async () => {
    await teardownServices([app, stack], true);
    expect(kept()).toEqual([]);
    expect(state.listed).toEqual([]);
  });

  it("records nothing when only Serve forgets the services (server removed, services kept)", async () => {
    await teardownServices([app, stack], false, { leaveRunning: true });
    expect(kept()).toEqual([]);
    expect(state.listed).toEqual([]);
  });

  it("records nothing for a service that never ran", async () => {
    await teardownServices([{ ...(app as object), currentDeploymentId: null } as never, { ...(stack as object), currentDeploymentId: null } as never], false);
    expect(kept()).toEqual([]);
  });

  it("puts a kept database on its environment", async () => {
    const database = {
      ...base,
      id: "d1",
      name: "main-db",
      slug: "main-db-x1",
      type: "database",
      runtime: { volumes: [] },
      database: { engine: "postgres", version: "17", username: "u", password: "enc", database: "app" },
    } as never;
    await teardownServices([database], false);
    const rows = state.inserts.filter((i) => i.table === tables.keptDatabase).flatMap((i) => i.rows);
    expect(rows).toEqual([expect.objectContaining({ projectId: "p1", environmentId: "e1", volume: "serve-main-db-x1-data", owned: true })]);
  });
});
