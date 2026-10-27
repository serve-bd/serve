import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

/*
 * serve.json and dashboard changes against a real database: a change made in the dashboard stays
 * on later deploys, and putting the file's values back undoes it.
 *
 *   SERVE_DB_LIVE=1 node --env-file=.env node_modules/vitest/vitest.mjs run tests/serve-config-keep-live.test.ts
 */

const live = !!process.env.SERVE_DB_LIVE;

describe.skipIf(!live)("serve.json keeps dashboard changes", () => {
  afterAll(async () => {
    const { db, schema } = await import("@/server/db");
    await db.delete(schema.organization).where(eq(schema.organization.id, "zztest-cfg"));
  });

  it("keeps changed, disabled and deleted items, and puts them back on request", async () => {
    const { db, schema } = await import("@/server/db");
    const { decryptOrNull, encrypt } = await import("@/server/crypto");
    const { applyServeConfig } = await import("@/server/services/serve-config");
    const { defaultRuntime } = await import("@/server/services/types");
    const S = "zztest-cfg";
    const quiet = { step: () => {}, line: () => {} };
    const file = (o: object) => ({ path: "serve.json", text: JSON.stringify(o) });
    const load = async () => (await db.select().from(schema.service).where(eq(schema.service.id, S)))[0];
    const apply = async (f: { path: string; text: string }, extra: object = {}) =>
      applyServeConfig(await load(), f, { deploymentId: "d1", commitSha: null, organizationId: S, log: quiet, now: true, ...extra });
    const state = async () => {
      const s = await load();
      const tasks = await db.select().from(schema.scheduledTask).where(eq(schema.scheduledTask.serviceId, S));
      const vars = await db.select().from(schema.envVar).where(eq(schema.envVar.serviceId, S));
      return {
        replicas: s.runtime.replicas,
        tasks: Object.fromEntries(tasks.map((t) => [t.name, `${t.schedule}|${t.enabled ? "on" : "off"}`])),
        vars: Object.fromEntries(vars.map((v) => [v.key, decryptOrNull(v.value)])),
        header: (s.proxy as { headers?: { name: string; value: string }[] } | null)?.headers?.find((h) => h.name === "X-A")?.value,
      };
    };
    const check = (_label: string, got: unknown, want: unknown) => expect(got).toEqual(want);

    await db.insert(schema.organization).values({ id: S, name: S, slug: S, createdAt: new Date() } as never);
    await db.insert(schema.project).values({ id: S, organizationId: S, name: S } as never);
    await db.insert(schema.environment).values({ id: S, projectId: S, name: "production" } as never);
    await db.insert(schema.service).values({
      id: S,
      projectId: S,
      environmentId: S,
      serverId: "local",
      name: S,
      slug: S,
      type: "app",
      runtime: defaultRuntime(),
      webhookSecret: "x",
      source: { type: "image", image: "nginx" },
    } as never);

    const v1 = {
      deploy: { replicas: 2 },
      tasks: [
        { name: "Sweep", schedule: "*/15 * * * *", command: "echo a" },
        { name: "Nightly", schedule: "0 3 * * *", command: "echo n" },
      ],
      variables: { values: { LOG: "info", MODE: "a" } },
      http: { headers: { "X-A": "1" } },
    };
    await apply(file(v1));

    // The dashboard changes things.
    const s = await load();
    await db
      .update(schema.service)
      .set({ runtime: { ...s.runtime, replicas: 3 }, proxy: { ...(s.proxy as object), headers: [{ name: "X-A", value: "2" }] } })
      .where(eq(schema.service.id, S));
    await db.delete(schema.scheduledTask).where(eq(schema.scheduledTask.name, "Nightly"));
    await db.update(schema.scheduledTask).set({ enabled: false }).where(eq(schema.scheduledTask.name, "Sweep"));
    const rows = await db.select().from(schema.envVar).where(eq(schema.envVar.serviceId, S));
    await db
      .update(schema.envVar)
      .set({ value: encrypt("debug") })
      .where(eq(schema.envVar.id, rows.find((r) => r.key === "LOG")!.id));
    await db.delete(schema.envVar).where(eq(schema.envVar.id, rows.find((r) => r.key === "MODE")!.id));

    // A new file changes everything.
    const v2 = {
      deploy: { replicas: 4 },
      tasks: [
        { name: "Sweep", schedule: "*/5 * * * *", command: "echo a" },
        { name: "Nightly", schedule: "0 4 * * *", command: "echo n" },
        { name: "Hourly", schedule: "0 * * * *", command: "echo h" },
      ],
      variables: { values: { LOG: "warn", MODE: "b", NEW: "x" } },
      http: { headers: { "X-A": "9" } },
    };
    await apply(file(v2));
    const after = await state();
    check("replicas kept", after.replicas, 3);
    check("tasks kept (Sweep disabled, Nightly deleted) and Hourly added", after.tasks, { Sweep: "*/15 * * * *|off", Hourly: "0 * * * *|on" });
    check("variables kept (LOG changed, MODE deleted), NEW added", after.vars, { LOG: "debug", NEW: "x" });
    check("header kept", after.header, "2");

    // Put the file's value back for replicas only.
    await apply(file(v2), { only: "runtime.replicas" });
    const one = await state();
    check("one setting back, the rest still kept", [one.replicas, one.vars.LOG, one.tasks.Sweep], [4, "debug", "*/15 * * * *|off"]);

    // Put everything back.
    await apply(file(v2), { force: true });
    const all = await state();
    check("all back: replicas", all.replicas, 4);
    check("all back: tasks", all.tasks, { Sweep: "*/5 * * * *|on", Nightly: "0 4 * * *|on", Hourly: "0 * * * *|on" });
    check("all back: variables", all.vars, { LOG: "warn", MODE: "b", NEW: "x" });
    check("all back: header", all.header, "9");

    // A deploy that fails before going live (applied, never finished), then one that succeeds.
    const v3 = {
      ...v2,
      tasks: [
        { name: "Sweep", schedule: "*/2 * * * *", command: "echo a" },
        { name: "Nightly", schedule: "0 4 * * *", command: "echo n" },
        { name: "Hourly", schedule: "0 * * * *", command: "echo h" },
      ],
    };
    await apply(file(v3), { now: false });
    await apply(file(v3));
    check("after a failed deploy the file still applies", (await state()).tasks.Sweep, "*/2 * * * *|on");

    // The file drops a task changed in the dashboard: it stays, owned by the dashboard.
    await db.update(schema.scheduledTask).set({ enabled: false }).where(eq(schema.scheduledTask.name, "Hourly"));
    const v4 = { ...v3, tasks: v3.tasks.filter((t) => t.name !== "Hourly" && t.name !== "Nightly") };
    await apply(file(v4));
    const t = await db.select().from(schema.scheduledTask).where(eq(schema.scheduledTask.serviceId, S));
    check("dropped but changed here stays; dropped unchanged goes", t.map((x) => `${x.name}:${x.fromFile}`).sort(), ["Hourly:false", "Sweep:true"]);
  }, 60_000);
});
