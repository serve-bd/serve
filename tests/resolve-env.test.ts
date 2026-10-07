import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-resolve-env";

// resolveEnv: how ${{…}} references are filled in, which value wins, and which values are redacted.

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, private: true }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => {
  // Each table answers with its rows, whatever the query: one query per table in resolveEnv.
  const table = (name: string) => new Proxy({}, { get: (_t, col) => (col === "__table" ? name : `${name}.${String(col)}`) });
  const schema = new Proxy({}, { get: (_t, name) => table(String(name)) });
  const chain = (tbl: { __table: string }) => {
    const rows = () => Promise.resolve(db.tables[tbl.__table] ?? []);
    const c = { innerJoin: () => c, where: rows };
    return c;
  };
  return { db: { select: () => ({ from: chain }) }, schema };
});
vi.mock("@/server/mesh/members", () => ({ meshMemberIds: async () => [], reachesPrivately: () => db.private }));
vi.mock("@/server/secrets/resolve", () => ({ resolveSecretRefs: async () => ({ found: new Map(), errors: [] }) }));
vi.mock("@/server/databases/branches", () => ({ branchVars: () => ({}) }));
vi.mock("@/server/security", () => ({ composeSecurityIssues: () => [] }));

const { encrypt } = await import("@/server/crypto");
const { resolveEnv } = await import("@/server/services/variables");

const service = (patch: Row = {}) =>
  ({
    id: "svc-web",
    name: "Web",
    slug: "web",
    hostname: null,
    type: "app",
    environmentId: "env1",
    serverId: "local",
    runtime: { port: 3000, replicas: 1 },
    distribution: null,
    replicaVars: null,
    database: null,
    proxy: null,
    ...patch,
  }) as never;
const postgres = service({
  id: "svc-db",
  name: "Postgres",
  slug: "postgres-x1",
  type: "database",
  runtime: {},
  database: { engine: "postgres", username: "app", password: encrypt("db-password-123"), database: "appdb" },
});
const v = (key: string, value: string, o: { build?: boolean; runtime?: boolean; literal?: boolean } = {}) => ({
  key,
  value: encrypt(value),
  buildTime: o.build ?? false,
  runtime: o.runtime ?? true,
  literal: o.literal ?? false,
});
const shared = (scope: "environmentId" | "projectId" | "organizationId", key: string, value: string) => ({
  environmentId: null,
  projectId: null,
  organizationId: null,
  [scope]: "x",
  key,
  value: encrypt(value),
});

function setup(own: Row[], opts: { shared?: Row[]; siblings?: Row[]; domains?: Row[]; server?: Row[] } = {}) {
  db.tables = {
    environment: [{ projectId: "p1", organizationId: "o1" }],
    envVar: own,
    sharedVar: opts.shared ?? [],
    service: opts.siblings ?? [service(), postgres],
    domain: (opts.domains ?? []).map((domain) => ({ domain })),
    databaseBranch: [],
    serverVar: opts.server ?? [],
  };
}

beforeEach(() => void (db.private = true));

describe("references", () => {
  it("fills in another service's variables by slug, name or dashed name", async () => {
    setup([v("A", "${{postgres-x1.DATABASE_URL}}"), v("B", "${{Postgres.USERNAME}}"), v("C", "${{ postgres.HOST }}")]);
    const env = await resolveEnv(service());
    expect(env.runtime.A).toMatch(/^postgres(ql)?:\/\/app:db-password-123@postgres-x1:5432\/appdb/);
    expect(env.runtime.B).toBe("app");
    expect(env.runtime.C).toBe("postgres-x1");
    expect(env.missing).toEqual([]);
  });

  it("reads every shared scope and the server's variables by name", async () => {
    setup([v("E", "${{environment.K}}/${{shared.K}}"), v("P", "${{project.K}}"), v("O", "${{org.K}}|${{team.K}}"), v("S", "${{server.K}}")], {
      shared: [shared("environmentId", "K", "env"), shared("projectId", "K", "proj"), shared("organizationId", "K", "org")],
      server: [{ key: "K", value: encrypt("srv") }],
    });
    const env = await resolveEnv(service());
    expect(env.runtime).toMatchObject({ E: "env/env", P: "proj", O: "org|org", S: "srv" });
  });

  it("own variables win over shared ones; Serve's own names win over both", async () => {
    setup([v("X", "${{K}}"), v("K", "own"), v("Y", "${{ONLY_SHARED}}"), v("SERVE_PUBLIC_URL", "${{SERVE_PUBLIC_URL}}"), v("Z", "${{SERVE_PUBLIC_URL}}")], {
      shared: [shared("environmentId", "K", "shared"), shared("environmentId", "ONLY_SHARED", "from-env")],
      domains: [{ serviceId: "svc-web", hostname: "web.example.com", https: true, tunnelId: null, redirectTo: null, generated: false, primary: true, composeService: null }],
    });
    const env = await resolveEnv(service());
    expect(env.runtime.X).toBe("own");
    expect(env.runtime.Y).toBe("from-env");
    expect(env.runtime.SERVE_PUBLIC_URL).toBe("https://web.example.com");
    expect(env.runtime.Z).toBe("https://web.example.com");
    // An app's port is always there.
    expect(env.runtime.PORT).toBe("3000");
  });

  it("follows references inside referenced values", async () => {
    setup([v("A", "x-${{B}}-x"), v("B", "${{shared.C}}"), v("C", "c")], { shared: [shared("environmentId", "C", "deep")] });
    expect((await resolveEnv(service())).runtime.A).toBe("x-deep-x");
  });

  it("stops on references to themselves instead of hanging", async () => {
    setup([v("A", "${{B}}"), v("B", "${{A}}"), v("C", "${{C}}${{C}}")]);
    const env = await resolveEnv(service());
    expect(typeof env.runtime.A).toBe("string");
    expect(env.runtime.C.length).toBeLessThan(10_000);
  });

  it("caps what references expand to", async () => {
    const big = "x".repeat(600_000);
    setup([v("A", "${{environment.BIG}}"), v("B", "${{shared.BIG}}")], { shared: [shared("environmentId", "BIG", big)] });
    const env = await resolveEnv(service());
    expect(env.missing.some((m) => /more than 1 MB/.test(m))).toBe(true);
    expect(env.runtime.A.length + env.runtime.B.length).toBeLessThanOrEqual(1024 * 1024);
  });

  it("leaves unknown references empty and reports them", async () => {
    setup([v("A", "a${{nope.KEY}}b"), v("B", "${{MISSING}}"), v("C", "${{postgres.NOPE}}")]);
    const env = await resolveEnv(service());
    expect(env.runtime).toMatchObject({ A: "ab", B: "", C: "" });
    expect(env.missing.sort()).toEqual(["MISSING", "nope.KEY", "postgres.NOPE"]);
  });

  it("keeps literal values as written", async () => {
    setup([v("TPL", "${{postgres.PASSWORD}}", { literal: true }), v("REF", "${{TPL}}")]);
    const env = await resolveEnv(service());
    expect(env.runtime.TPL).toBe("${{postgres.PASSWORD}}");
    expect(env.runtime.REF).toBe("${{postgres.PASSWORD}}");
    expect(env.literal).toEqual(["TPL"]);
  });

  it("puts variables in the build, the runtime, or both, as set", async () => {
    setup([v("B", "b", { build: true, runtime: false }), v("R", "r"), v("BR", "br", { build: true })]);
    const env = await resolveEnv(service());
    expect(env.build).toEqual({ B: "b", BR: "br" });
    expect(env.runtime).toEqual({ PORT: "3000", R: "r", BR: "br" });
  });

  it("two services with one name answer only to their slugs", async () => {
    const a = service({ id: "a", name: "API", slug: "api-1", runtime: { port: 1 } });
    const b = service({ id: "b", name: "API", slug: "api-2", runtime: { port: 2 } });
    setup([v("X", "${{api.PORT}}"), v("Y", "${{api-2.PORT}}")], { siblings: [service(), a, b] });
    const env = await resolveEnv(service());
    expect(env.runtime.X).toBe("");
    expect(env.runtime.Y).toBe("2");
  });

  it("private names of a service on an unreachable server are reported, public ones still filled in", async () => {
    db.private = false;
    setup([v("H", "${{postgres.HOST}}"), v("U", "${{postgres.USERNAME}}")], { siblings: [service(), { ...(postgres as Row), serverId: "far" }] });
    const env = await resolveEnv(service());
    expect(env.runtime.H).toBe("");
    expect(env.runtime.U).toBe("app");
    expect(env.missing[0]).toMatch(/^postgres\.HOST \(runs on another server/);
  });
});

describe("secrets to redact", () => {
  it("redacts values of secret-looking keys and long values, not short plain ones", async () => {
    setup([v("API_TOKEN", "tok-123"), v("DB", "${{postgres.DATABASE_URL}}"), v("NAME", "short"), v("NOTE", "a value of twenty chars"), v("TOKEN", "abc")]);
    const env = await resolveEnv(service());
    expect(env.secrets).toContain("tok-123");
    expect(env.secrets).toContain(env.runtime.DB);
    expect(env.secrets).toContain("a value of twenty chars");
    expect(env.secrets).not.toContain("short");
    // Too short to redact without blanking common substrings of every log line.
    expect(env.secrets).not.toContain("abc");
  });

  it("redacts a shared secret that ended up inside another value", async () => {
    setup([v("CONN", "user:${{project.DB_PASSWORD}}@host")], { shared: [shared("projectId", "DB_PASSWORD", "hunter22")] });
    const env = await resolveEnv(service());
    expect(env.runtime.CONN).toBe("user:hunter22@host");
    expect(env.secrets).toContain("hunter22");
  });
});
