import { describe, expect, it } from "vitest";
import { type MoveInput, type MoveService, planMove, referencesIn, scopeTarget } from "@/server/services/move-plan";

const svc = (id: string, name: string, patch: Partial<MoveService> = {}): MoveService => ({
  id,
  name,
  slug: `${name.toLowerCase()}-${id}`,
  hostname: null,
  type: "app",
  environmentId: "env-a",
  projectId: "proj-a",
  parentServiceId: null,
  ...patch,
});

const input = (patch: Partial<MoveInput>): MoveInput => ({
  moving: [],
  children: [],
  sourceServices: [],
  targetServices: [],
  vars: {},
  selfKeys: {},
  envKeys: {},
  targetEnvKeys: [],
  projectKeys: {},
  targetProjectId: "proj-b",
  ...patch,
});

describe("planMove", () => {
  const web = svc("w1", "web");
  const db = svc("d1", "postgresql", { type: "database" });
  const worker = svc("k1", "worker");

  it("renames services whose name is taken in the target", () => {
    const plan = planMove(
      input({ moving: [db], sourceServices: [db], targetServices: [svc("x1", "postgresql", { environmentId: "env-b" }), svc("x2", "postgresql-2", { environmentId: "env-b" })] }),
    );
    expect(plan.services[0]).toMatchObject({ name: "postgresql", newName: "postgresql-3" });
    expect(plan.services[0].notes[0]).toMatch(/Renamed to postgresql-3/);
  });

  it("finds references that break in both directions and suggests moving the other side", () => {
    const plan = planMove(
      input({
        moving: [db],
        sourceServices: [web, db, worker],
        vars: {
          w1: [{ key: "DATABASE_URL", value: "${{postgresql.DATABASE_URL}}" }],
          d1: [{ key: "WORKER", value: "http://${{ worker.SERVE_PRIVATE_DOMAIN }}" }],
        },
      }),
    );
    expect(plan.broken.map((b) => [b.serviceName, b.key, b.fixWith])).toEqual([
      ["web", "DATABASE_URL", "w1"],
      ["postgresql", "WORKER", "k1"],
    ]);
    expect(plan.suggestions.map((s) => s.name).sort()).toEqual(["web", "worker"]);
  });

  it("keeps references between services that move together, rewriting renamed ones", () => {
    const plan = planMove(
      input({
        moving: [web, db],
        sourceServices: [web, db],
        targetServices: [svc("x1", "postgresql", { environmentId: "env-b" })],
        vars: { w1: [{ key: "DATABASE_URL", value: "${{ postgresql.DATABASE_URL }}?ssl=1" }] },
      }),
    );
    expect(plan.broken).toEqual([]);
    expect(plan.rewrites.w1).toEqual([{ key: "DATABASE_URL", value: "${{postgresql-2.DATABASE_URL}}?ssl=1" }]);
  });

  it("leaves slug references alone when renaming", () => {
    const plan = planMove(
      input({
        moving: [web, db],
        sourceServices: [web, db],
        targetServices: [svc("x1", "postgresql", { environmentId: "env-b" })],
        vars: { w1: [{ key: "URL", value: `\${{${db.slug}.DATABASE_URL}}` }] },
      }),
    );
    expect(plan.rewrites.w1).toBeUndefined();
  });

  it("flags shared variables the target does not have", () => {
    const plan = planMove(
      input({
        moving: [web],
        sourceServices: [web],
        vars: {
          w1: [
            { key: "A", value: "${{environment.SENTRY_DSN}}" },
            { key: "B", value: "${{project.API}}" },
            { key: "C", value: "${{PORT}}" },
          ],
        },
        selfKeys: { w1: ["PORT"] },
        envKeys: { "env-a": ["SENTRY_DSN"] },
        projectKeys: { "proj-a": ["API"] },
      }),
    );
    expect(plan.broken.map((b) => b.key)).toEqual(["A", "B"]);
  });

  it("warns when a name would point at another service in the target", () => {
    const plan = planMove(
      input({
        moving: [web],
        sourceServices: [web, db],
        targetServices: [svc("x1", "postgresql", { environmentId: "env-b" })],
        vars: { w1: [{ key: "DATABASE_URL", value: "${{postgresql.DATABASE_URL}}" }] },
      }),
    );
    expect(plan.broken[0].reason).toMatch(/would point there/);
  });

  it("moves previews along and clears a private hostname that is taken", () => {
    const preview = svc("p1", "web-pr-3", { parentServiceId: "w1" });
    const named = { ...web, hostname: "api" };
    const plan = planMove(input({ moving: [named], children: [preview], sourceServices: [named, preview], targetServices: [svc("x1", "api", { environmentId: "env-b" })] }));
    expect(plan.services.map((s) => s.id)).toEqual(["w1", "p1"]);
    expect(plan.services[0].clearHostname).toBe(false);
    const clash = planMove(input({ moving: [named], sourceServices: [named], targetServices: [svc("x2", "other", { environmentId: "env-b", hostname: "api" })] }));
    expect(clash.services[0].clearHostname).toBe(true);
  });
});

describe("reference helpers", () => {
  it("parses scoped and bare references", () => {
    expect(referencesIn("a ${{ Db.URL }} b ${{PORT}}")).toEqual([
      { ref: "Db.URL", scope: "db", key: "URL" },
      { ref: "PORT", scope: null, key: "PORT" },
    ]);
  });

  it("resolves names like deploys do and refuses shared names", () => {
    const a = svc("a", "My App");
    expect(scopeTarget("my-app", [a])?.id).toBe("a");
    expect(scopeTarget("postgresql", [svc("b", "postgresql"), svc("c", "postgresql")])).toBeNull();
  });
});
