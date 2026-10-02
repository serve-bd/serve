import { beforeEach, describe, expect, it, vi } from "vitest";

// Members who are not Root admins must not run commands in a service with host-level access by
// another way than the console (which refuses them): scheduled tasks and database settings.

const writes: string[] = [];
vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => ({
  db: {
    insert: () => ({ values: () => (writes.push("insert"), Promise.resolve()) }),
    update: () => ({ set: () => ({ where: () => (writes.push("update"), Promise.resolve()) }) }),
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  },
  schema: new Proxy({}, { get: () => new Proxy({}, { get: () => ({}) }) }),
}));

const ctx = { isInstanceAdmin: false, isRoot: true, org: { id: "org" }, user: { id: "u" }, secrets: false, can: (p: string) => p !== "variables.view-secrets" || ctx.secrets };
vi.mock("@/server/auth", () => ({ requirePermission: async () => ctx, ForbiddenError: class ForbiddenError extends Error {} }));
vi.mock("@/server/activity", () => ({ logActivity: async () => {} }));
vi.mock("@/server/services/tasks", () => ({ startTaskRun: async () => "run" }));

const runtime = { volumes: [] as { kind: string }[], ports: [], privileged: false, capAdd: [], gpus: null, devices: [] };
const service = {
  id: "s",
  name: "db",
  projectId: "p",
  type: "database",
  status: "running",
  runtime,
  compose: null,
  database: { engine: "postgres", version: "17", username: "u", password: "x", database: "d" },
};
vi.mock("@/server/services/access", () => ({ serviceInOrg: async () => ({ service, project: { id: "p" } }) }));

import { changeDatabasePassword, updateDatabaseSettings } from "@/server/actions/databases";
import { saveTask } from "@/server/actions/tasks";

const task = { name: "t", schedule: "* * * * *", command: "id", timeoutSeconds: 60, enabled: true };

describe("host-level access guards", () => {
  beforeEach(() => {
    writes.length = 0;
    ctx.isInstanceAdmin = false;
    ctx.secrets = false;
    runtime.volumes = [];
    runtime.privileged = false;
  });

  it("refuses tasks on a privileged service to members who are not Root admins", async () => {
    runtime.privileged = true;
    const r = await saveTask("s", null, task);
    expect(r.ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it("refuses tasks on a service with host mounts", async () => {
    runtime.volumes = [{ kind: "bind" }];
    expect((await saveTask("s", null, task)).ok).toBe(false);
  });

  it("lets Root admins and services without host access have tasks", async () => {
    expect((await saveTask("s", null, task)).ok).toBe(true);
    runtime.privileged = true;
    ctx.isInstanceAdmin = true;
    expect((await saveTask("s", null, task)).ok).toBe(true);
  });

  it("refuses database settings of a database with host mounts", async () => {
    runtime.volumes = [{ kind: "bind" }];
    const r = await updateDatabaseSettings("s", { extraArgs: "-c archive_mode=on" });
    expect(r.ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it("saves database settings without host access", async () => {
    expect((await updateDatabaseSettings("s", { description: "main" })).ok).toBe(true);
  });

  it("lets only members who see secrets choose a database password or turn on trust", async () => {
    const chosen = await changeDatabasePassword("s", "known-password-123");
    expect(chosen.ok).toBe(false);
    if (!chosen.ok) expect(chosen.error).toMatch(/secret/i);
    expect((await updateDatabaseSettings("s", { hostAuthMethod: "trust" })).ok).toBe(false);
    ctx.secrets = true;
    expect((await updateDatabaseSettings("s", { hostAuthMethod: "trust" })).ok).toBe(true);
    expect(writes).toEqual(["update"]);
  });
});
