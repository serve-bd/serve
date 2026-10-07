import { beforeEach, describe, expect, it, vi } from "vitest";

// Deleting kept data: services.manage and the delete proof, only the organization's own rows, the
// Docker volume removed only when Serve made it, a host folder never touched, and a volume a
// container still uses refused with the record kept.

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  removed: [] as string[],
  removeError: null as { statusCode?: number; message: string } | null,
  proofError: null as Error | null,
  permissionError: null as Error | null,
  projectIds: null as string[] | null,
  activity: [] as { action: string; message: string }[],
}));
const tables = vi.hoisted(() => {
  const cols = (t: string) => ({ t, id: `${t}.id`, organizationId: `${t}.org`, serverId: `${t}.server`, projectId: `${t}.project`, volume: `${t}.volume`, owned: `${t}.owned` });
  return { keptDatabase: cols("keptDatabase"), keptVolume: cols("keptVolume") };
});
vi.mock("server-only", () => ({}));
vi.mock("drizzle-orm", () => ({
  eq: (c: string, v: unknown) => ({ c, v }),
  and: (...parts: { c: string; v: unknown }[]) => parts,
}));
// Rows match on their table, id and organization, like the real queries.
const matches = (table: { t: string }, where: { c: string; v: unknown }[]) =>
  state.rows.filter((r) => r.table === table.t && where.every((w) => (w.c.endsWith(".id") ? r.id === w.v : w.c.endsWith(".org") ? r.organizationId === w.v : true)));
vi.mock("@/server/db", () => ({
  db: {
    select: () => ({ from: (table: { t: string }) => ({ where: async (w: { c: string; v: unknown }[]) => matches(table, w) }) }),
    delete: (table: { t: string }) => ({
      where: (w: { c: string; v: unknown }[]) => ({
        returning: async () => {
          const found = matches(table, w);
          state.rows = state.rows.filter((r) => !found.includes(r));
          return found;
        },
      }),
    }),
    insert: () => ({ values: async (row: Record<string, unknown>) => void state.rows.push(row) }),
  },
  schema: tables,
}));
vi.mock("@/server/auth", () => ({
  requirePermission: async (p: string) => {
    if (p !== "services.manage") throw new Error(`asked for ${p}`);
    if (state.permissionError) throw state.permissionError;
    return {
      org: { id: "o1" },
      user: { id: "u1" },
      projectIds: state.projectIds,
      canAccessProject: (id: string) => !state.projectIds || state.projectIds.includes(id),
    };
  },
}));
vi.mock("@/server/delete-proof", () => ({
  requireDeleteProof: async () => {
    if (state.proofError) throw state.proofError;
  },
}));
vi.mock("@/server/activity", () => ({ logActivity: async (e: { action: string; message: string }) => void state.activity.push(e) }));
vi.mock("@/server/monitoring/containers", () => ({ withTimeout: (p: Promise<unknown>) => p }));
vi.mock("@/server/servers/context", () => ({
  getServer: async () => ({
    docker: {
      getVolume: (name: string) => ({
        remove: async () => {
          if (state.removeError) throw state.removeError;
          state.removed.push(name);
        },
      }),
    },
  }),
}));

const { UserError } = await import("@/server/action");
const { deleteKeptData } = await import("@/server/actions/kept-data");

const volume = { table: "keptVolume", id: "k1", organizationId: "o1", serverId: "s1", projectId: "p1", volume: "serve-web-x1-uploads", owned: true };
const database = { table: "keptDatabase", id: "k2", organizationId: "o1", serverId: "s1", projectId: "p1", volume: "serve-db-x1-data", owned: true, password: "enc" };

describe("deleting kept data", () => {
  beforeEach(() => {
    state.rows = [{ ...volume }, { ...database }];
    state.removed = [];
    state.removeError = null;
    state.proofError = null;
    state.permissionError = null;
    state.projectIds = null;
    state.activity = [];
  });

  it("removes Serve's volume, then the record, and logs it", async () => {
    expect(await deleteKeptData("volume", "k1", "pw")).toEqual({ ok: true, data: null });
    expect(state.removed).toEqual(["serve-web-x1-uploads"]);
    expect(state.rows.map((r) => r.id)).toEqual(["k2"]);
    expect(state.activity).toEqual([expect.objectContaining({ action: "kept-data.deleted", message: "Deleted kept data serve-web-x1-uploads" })]);
  });

  it("removes a kept database's volume", async () => {
    expect((await deleteKeptData("database", "k2", "pw")).ok).toBe(true);
    expect(state.removed).toEqual(["serve-db-x1-data"]);
    expect(state.rows.map((r) => r.id)).toEqual(["k1"]);
  });

  it("needs services.manage", async () => {
    state.permissionError = new UserError("You cannot manage services.");
    expect(await deleteKeptData("volume", "k1", "pw")).toEqual({ ok: false, error: "You cannot manage services." });
    expect(state.removed).toEqual([]);
    expect(state.rows).toHaveLength(2);
  });

  it("needs the delete proof", async () => {
    state.proofError = new UserError("That password is not right. Nothing was deleted.");
    expect(await deleteKeptData("volume", "k1", "bad")).toEqual({ ok: false, error: "That password is not right. Nothing was deleted." });
    expect(state.removed).toEqual([]);
    expect(state.rows).toHaveLength(2);
  });

  it("never reaches another organization's data", async () => {
    state.rows = [{ ...volume, organizationId: "o2" }];
    expect(await deleteKeptData("volume", "k1", "pw")).toEqual({ ok: false, error: "Kept data not found." });
    expect(state.removed).toEqual([]);
    expect(state.rows).toHaveLength(1);
  });

  it("keeps members limited to some projects to those projects' data", async () => {
    state.projectIds = ["p9"];
    expect((await deleteKeptData("volume", "k1", "pw")).ok).toBe(false);
    state.rows = [{ ...database, projectId: null }];
    expect((await deleteKeptData("database", "k2", "pw")).ok).toBe(false);
    expect(state.removed).toEqual([]);
  });

  it("only forgets a volume made outside Serve", async () => {
    state.rows = [{ ...database, owned: false, volume: "legacy-pgdata" }];
    const res = await deleteKeptData("database", "k2", "pw");
    expect(res).toEqual({ ok: true, data: { note: expect.stringContaining("legacy-pgdata was made outside Serve and stays") } });
    expect(state.removed).toEqual([]);
    expect(state.rows).toEqual([]);
  });

  it("never deletes a host folder, only forgets it", async () => {
    state.rows = [{ ...database, volume: "/srv/pg" }];
    const res = await deleteKeptData("database", "k2", "pw");
    expect(res).toEqual({ ok: true, data: { note: expect.stringContaining("The folder stays at /srv/pg") } });
    expect(state.removed).toEqual([]);
    expect(state.rows).toEqual([]);
  });

  it("refuses a name that is not a Docker volume name before asking Docker", async () => {
    state.rows = [{ ...volume, volume: "../etc" }];
    expect((await deleteKeptData("volume", "k1", "pw")).ok).toBe(false);
    expect(state.removed).toEqual([]);
    expect(state.rows).toHaveLength(1);
  });

  it("refuses a volume a container still uses, and keeps the record", async () => {
    state.removeError = { statusCode: 409, message: "volume is in use" };
    const res = await deleteKeptData("volume", "k1", "pw");
    expect(res).toEqual({ ok: false, error: expect.stringContaining("is already in use by a container") });
    expect(state.rows.map((r) => r.id).sort()).toEqual(["k1", "k2"]);
    expect(state.activity).toEqual([]);
  });

  it("treats a volume already gone as deleted", async () => {
    state.removeError = { statusCode: 404, message: "no such volume" };
    expect((await deleteKeptData("volume", "k1", "pw")).ok).toBe(true);
    expect(state.rows.map((r) => r.id)).toEqual(["k2"]);
  });
});
