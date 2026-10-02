// biome-ignore-all lint/suspicious/noExplicitAny: API answers are checked field by field in the tests.
import crypto from "node:crypto";
import http from "node:http";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/*
 * End-to-end tests of the main flows against a running Serve, through its API.
 *
 *   SERVE_E2E_URL=http://localhost:3000 \
 *   SERVE_E2E_TOKEN=srv_...            (an Admin token of an organization admin) \
 *   SERVE_E2E_DATABASE_URL=postgres://... (optional: the instance's database, for the permission tests) \
 *   SERVE_E2E_SERVER=<server id>         (optional: deploy there instead of the default server) \
 *   SERVE_E2E_PROXY_URL=http://127.0.0.1:8080 (optional: this machine's proxy, for the host port test) \
 *   pnpm test:e2e
 *
 * Everything the tests create is named zz-e2e-* and removed at the end. They deploy real
 * containers (nginx:alpine, postgres and redis) on the organization's default server.
 */

const BASE = `${(process.env.SERVE_E2E_URL ?? "http://localhost:3000").replace(/\/$/, "")}/api/v1`;
const ADMIN = process.env.SERVE_E2E_TOKEN ?? "";
const DB_URL = process.env.SERVE_E2E_DATABASE_URL ?? "";
const SERVER = process.env.SERVE_E2E_SERVER ? { serverId: process.env.SERVE_E2E_SERVER } : {};
const run = ADMIN ? describe : describe.skip;

type Res = { status: number; json: Record<string, any> };

async function api(token: string, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

/** The data of a call that must succeed with `status`. */
async function ok(token: string, method: string, path: string, body?: unknown, status = 200) {
  const r = await api(token, method, path, body);
  if (r.status !== status) throw new Error(`${method} ${path}: expected ${status}, got ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`);
  return r.json;
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 180_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const finished = (id: string) =>
  until(`deployment ${id}`, async () => {
    const d = (await ok(ADMIN, "GET", `/deployments/${id}`)).deployment;
    return ["success", "failed", "cancelled"].includes(d.status) ? d.status : null;
  });

/** Run a command in a service through a one-off scheduled task; returns its output. */
async function runCommand(serviceId: string, command: string) {
  const name = `zz-e2e-${crypto.randomBytes(3).toString("hex")}`;
  const { id } = await ok(ADMIN, "POST", `/services/${serviceId}/tasks`, { name, schedule: "0 3 1 1 *", command }, 201);
  await ok(ADMIN, "POST", `/tasks/${id}/run`, undefined, 202);
  const done = await until(`task ${name}`, async () => {
    const runs = (await ok(ADMIN, "GET", `/tasks/${id}/runs`)).runs;
    return runs[0] && runs[0].status !== "running" ? runs[0] : null;
  });
  await ok(ADMIN, "DELETE", `/tasks/${id}`);
  return done as { status: string; exitCode: number | null; output: string };
}

run("main flows", () => {
  const made = { projectId: "", tokenIds: [] as string[] };
  const tokens: Record<string, string> = {};
  let sql: ReturnType<typeof postgres> | null = null;
  let me: Record<string, any>;
  let environmentId = "";
  let appId = "";
  let dbId = "";
  let redisId = "";

  /** A token of the same owner with these grants (written straight into the instance's database). */
  async function tokenWith(name: string, grants: string[], projectIds: string[] | null = null) {
    const raw = `srv_${crypto.randomBytes(24).toString("base64url")}`;
    const id = `zze2e${crypto.randomBytes(6).toString("hex")}`;
    await sql!`insert into api_token (id, organization_id, name, token_hash, prefix, user_id, scopes, project_ids)
      values (${id}, ${me.organization.id}, ${`zz-e2e-${name}`}, ${crypto.createHash("sha256").update(raw).digest("hex")}, ${raw.slice(0, 10)}, ${me.user.id}, ${grants}, ${projectIds})`;
    made.tokenIds.push(id);
    return raw;
  }

  beforeAll(async () => {
    me = await ok(ADMIN, "GET", "/me");
    if (!me.admin) throw new Error("SERVE_E2E_TOKEN must be an Admin token of an organization admin.");
    if (DB_URL) {
      sql = postgres(DB_URL, { max: 1 });
      tokens.read = await tokenWith("read", ["projects.view", "logs.view"]);
      tokens.deploy = await tokenWith("deploy", ["projects.view", "logs.view", "services.deploy"]);
    }
  });

  afterAll(async () => {
    if (appId) await api(ADMIN, "DELETE", `/services/${appId}?volumes=true`);
    if (dbId) await api(ADMIN, "DELETE", `/services/${dbId}?volumes=true`);
    if (redisId) await api(ADMIN, "DELETE", `/services/${redisId}?volumes=true`);
    if (made.projectId) {
      await new Promise((r) => setTimeout(r, 3000));
      await api(ADMIN, "DELETE", `/projects/${made.projectId}`);
    }
    if (sql) {
      if (made.tokenIds.length) await sql`delete from api_token where id = any(${made.tokenIds})`;
      await sql.end();
    }
  });

  it("answers errors as JSON with the right status", async () => {
    expect((await api("srv_nope", "GET", "/projects")).status).toBe(401);
    expect((await api(ADMIN, "GET", "/no-such-route")).status).toBe(404);
    expect((await api(ADMIN, "DELETE", "/projects")).status).toBe(405);
    expect((await api(ADMIN, "POST", "/services", { type: "app" })).status).toBe(400);
    expect((await api(ADMIN, "GET", "/services/does-not-exist")).status).toBe(404);
  });

  it("creates a project with a production environment", async () => {
    const r = await ok(ADMIN, "POST", "/projects", { name: "zz-e2e-project" }, 201);
    made.projectId = r.project.id;
    environmentId = r.environments[0].id;
    expect(r.environments[0].name).toBe("production");
  });

  it("refuses what a token's permissions do not allow", async () => {
    if (!sql) return;
    const r = await api(tokens.read, "POST", "/projects", { name: "zz-e2e-x" });
    expect(r.status).toBe(403);
    expect(r.json.missing).toContain("projects.manage");
    expect((await api(tokens.read, "GET", "/instance/updates")).status).toBe(403);
    expect((await api(tokens.read, "GET", "/projects")).status).toBe(200);
  });

  it("creates an app, sets variables and adds a domain", async () => {
    appId = (
      await ok(
        ADMIN,
        "POST",
        "/services",
        { type: "app", projectId: made.projectId, environmentId, name: "zz-e2e-web", source: { type: "image", image: "nginx:alpine" }, ...SERVER },
        201,
      )
    ).id;
    await ok(ADMIN, "PATCH", `/services/${appId}/variables`, { variables: { GREETING: "hello", SECRET: "s3cr3t" } });
    await ok(ADMIN, "PATCH", `/services/${appId}/variables`, { variables: { GREETING: "hi" } });
    const vars = (await ok(ADMIN, "GET", `/services/${appId}/variables`)).variables;
    expect(vars.find((v: any) => v.key === "GREETING").value).toBe("hi");
    expect(vars.find((v: any) => v.key === "SECRET").value).toBe("s3cr3t");
    if (sql) {
      const hidden = (await ok(tokens.read, "GET", `/services/${appId}/variables`)).variables;
      expect(hidden.every((v: any) => v.value === undefined)).toBe(true);
      expect((await api(tokens.read, "PATCH", `/services/${appId}/variables`, { variables: { A: "b" } })).status).toBe(403);
    }
    const domains = (await ok(ADMIN, "GET", `/services/${appId}/domains`)).domains;
    expect(domains.length).toBeGreaterThanOrEqual(1);
    const added = await api(ADMIN, "POST", `/services/${appId}/domains`, { hostname: `zz-e2e-${crypto.randomBytes(3).toString("hex")}.invalid` });
    // An unverified domain may be refused; either way the answer is a clear JSON status.
    expect([200, 201, 400, 403]).toContain(added.status);
  });

  it("deploys the app, with logs, containers and a restart", async () => {
    const token = sql ? tokens.deploy : ADMIN;
    const { deploymentId } = await ok(token, "POST", `/services/${appId}/deploy`, {}, 202);
    expect(await finished(deploymentId)).toBe("success");
    expect((await ok(ADMIN, "GET", `/deployments/${deploymentId}/logs`)).logs).toContain("Deployed successfully");
    const containers = (await ok(ADMIN, "GET", `/services/${appId}/containers`)).containers;
    expect(containers.some((c: any) => c.state === "running")).toBe(true);
    // The variables reached the container.
    const env = await runCommand(appId, "printenv GREETING");
    expect(env.output).toContain("hi");
    await ok(token, "POST", `/services/${appId}/restart`, undefined, 202);
    await until("restart", async () => ((await ok(ADMIN, "GET", `/services/${appId}`)).service.status === "running" ? true : null));
    if (sql) expect((await api(tokens.deploy, "PATCH", `/services/${appId}`, { autoDeploy: true })).status).toBe(403);
  });

  it("creates a database and shows its connection only with secrets access", async () => {
    dbId = (
      await ok(ADMIN, "POST", "/services", { type: "database", projectId: made.projectId, environmentId, name: "zz-e2e-pg", engine: "postgres", deploy: true, ...SERVER }, 201)
    ).id;
    await until("database running", async () => ((await ok(ADMIN, "GET", `/services/${dbId}`)).service.status === "running" ? true : null));
    const full = (await ok(ADMIN, "GET", `/services/${dbId}/connection`)).connection;
    expect(full.variables.DATABASE_URL).toMatch(/^postgres/);
    if (sql) {
      const limited = (await ok(tokens.read, "GET", `/services/${dbId}/connection`)).connection;
      expect(limited.variables.HOST).toBeTruthy();
      expect(limited.variables.PASSWORD).toBeUndefined();
      expect(limited.variables.DATABASE_URL).toBeUndefined();
    }
  });

  it("adds a database user with read-only access, changes it, and deletes it", async () => {
    const psqlAs = (user: string, password: string, q: string) => `PGPASSWORD='${password}' psql -h 127.0.0.1 -U ${user} -d "$POSTGRES_DB" -tAc "${q}"`;
    expect((await runCommand(dbId, `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "create table zz_users (v text); insert into zz_users values ('a')"`)).exitCode).toBe(0);
    const list = await ok(ADMIN, "GET", `/services/${dbId}/users`);
    expect(list.users.find((u: any) => u.protectedReason === "Serve's own login")).toBeTruthy();
    const made = (await ok(ADMIN, "POST", `/services/${dbId}/users`, { username: "zz_reader", access: "read", databases: [list.mainDatabase] }, 201)).user;
    expect(made.privateUrl).toContain("zz_reader");
    expect((await runCommand(dbId, psqlAs("zz_reader", made.password, "select v from zz_users"))).output).toContain("a");
    expect((await runCommand(dbId, psqlAs("zz_reader", made.password, "insert into zz_users values ('b')"))).exitCode).not.toBe(0);
    await ok(ADMIN, "PUT", `/services/${dbId}/users/zz_reader/access`, { access: "readwrite", databases: [list.mainDatabase] });
    expect((await runCommand(dbId, psqlAs("zz_reader", made.password, "insert into zz_users values ('b')"))).exitCode).toBe(0);
    const changed = (await ok(ADMIN, "POST", `/services/${dbId}/users/zz_reader/password`, {})).user;
    expect(changed.password).not.toBe(made.password);
    expect((await ok(ADMIN, "GET", `/services/${dbId}/users/zz_reader/connection`)).user.password).toBe(changed.password);
    // Serve's own login is never changed from the Users page.
    const own = list.users.find((u: any) => u.protectedReason === "Serve's own login").username;
    expect((await api(ADMIN, "DELETE", `/services/${dbId}/users/${own}`)).status).toBe(400);
    if (sql) expect((await api(tokens.read, "POST", `/services/${dbId}/users`, { username: "zz_x", access: "read", databases: [list.mainDatabase] })).status).toBe(403);
    await ok(ADMIN, "DELETE", `/services/${dbId}/users/zz_reader`);
    expect((await ok(ADMIN, "GET", `/services/${dbId}/users`)).users.some((u: any) => u.username === "zz_reader")).toBe(false);
  });

  it("browses and queries a database, read only unless told otherwise", async () => {
    const data = `/services/${dbId}/data`;
    const overview = await ok(ADMIN, "GET", data);
    expect(overview.family).toBe("sql");
    const database = overview.database;
    expect(overview.databases.map((d: any) => d.name)).toContain(database);
    // Changes need readOnly: false, and land in the activity log.
    const create = await ok(ADMIN, "POST", `${data}/query`, {
      database,
      readOnly: false,
      query: `CREATE TABLE zz_explore (id int PRIMARY KEY, "we'ird ""name""" text); INSERT INTO zz_explore SELECT g, 'v' || g FROM generate_series(1, 60) g; UPDATE zz_explore SET "we'ird ""name""" = E'a\\nb ''q''' WHERE id = 1`,
    });
    expect(create.error).toBeNull();
    expect(create.result).toMatchObject({ kind: "done", affected: 1 });
    const tables = (await ok(ADMIN, "GET", `${data}?database=${encodeURIComponent(database)}`)).tables;
    expect(tables.find((t: any) => t.name === "zz_explore")).toMatchObject({ schema: "public", kind: "table" });
    const structure = await ok(ADMIN, "GET", `${data}/structure?database=${encodeURIComponent(database)}&table=zz_explore`);
    expect(structure.columns.map((c: any) => [c.name, c.primaryKey])).toEqual([
      ["id", true],
      [`we'ird "name"`, false],
    ]);
    const page = await ok(ADMIN, "POST", `${data}/rows`, { database, schema: "public", table: "zz_explore", page: 1, sort: { column: "id", desc: true } });
    expect(page).toMatchObject({ columns: ["id", `we'ird "name"`], total: 60 });
    expect(page.rows.length).toBe(10);
    expect(page.rows[0][0]).toBe("10");
    const filtered = await ok(ADMIN, "POST", `${data}/rows`, { database, table: "zz_explore", filter: { column: `we'ird "name"`, op: "eq", value: "a\nb 'q'" } });
    expect(filtered.rows).toEqual([["1", "a\nb 'q'"]]);
    // One value of one row, found by its primary key.
    const cell = { database, schema: "public", table: "zz_explore", key: [{ column: "id", value: "2" }], column: `we'ird "name"` };
    await ok(ADMIN, "PATCH", `${data}/rows`, { ...cell, value: "edited 'x'" });
    expect((await ok(ADMIN, "POST", `${data}/rows`, { database, table: "zz_explore", filter: { column: "id", op: "eq", value: "2" } })).rows).toEqual([["2", "edited 'x'"]]);
    await ok(ADMIN, "PATCH", `${data}/rows`, { ...cell, value: null });
    expect((await ok(ADMIN, "POST", `${data}/rows`, { database, table: "zz_explore", filter: { column: "id", op: "eq", value: "2" } })).rows).toEqual([["2", null]]);
    expect((await api(ADMIN, "PATCH", `${data}/rows`, { ...cell, column: "id", value: "5" })).status).toBe(400);
    expect((await api(ADMIN, "PATCH", `${data}/rows`, { ...cell, key: [{ column: "id", value: "999" }], value: "x" })).status).toBe(400);
    // Read only by default: the database refuses the write.
    const select = await ok(ADMIN, "POST", `${data}/query`, { database, query: "SELECT count(*) AS n FROM zz_explore" });
    expect(select.result).toMatchObject({ kind: "rows", columns: ["n"], rows: [["60"]] });
    expect(select.ms).toBeGreaterThan(0);
    const refused = await ok(ADMIN, "POST", `${data}/query`, { database, query: "DELETE FROM zz_explore" });
    expect(refused.result).toBeNull();
    expect(refused.error).toMatch(/read-only transaction/);
    expect((await api(ADMIN, "POST", `${data}/query`, { database, query: "COMMIT; DELETE FROM zz_explore" })).status).toBe(400);
    expect((await ok(ADMIN, "POST", `${data}/query`, { database, query: "SELECT count(*) FROM zz_explore" })).result.rows).toEqual([["60"]]);
    const activity = (await ok(ADMIN, "GET", `/activity?projectId=${made.projectId}&limit=50`)).activity;
    expect(activity.find((a: any) => a.action === "database.query")?.message).toContain("CREATE TABLE zz_explore");
    expect(activity.some((a: any) => a.action === "database.query" && a.message.includes("DELETE FROM zz_explore"))).toBe(false);
    expect(activity.find((a: any) => a.action === "database.row-edited")?.message).toContain("of the row id = 2 in zz_explore");
    if (sql) {
      // Reading rows is like opening a shell on the database: without the console permission, nothing.
      expect((await api(tokens.read, "GET", data)).status).toBe(403);
      expect((await api(tokens.read, "POST", `${data}/rows`, { database, table: "zz_explore" })).status).toBe(403);
      expect((await api(tokens.read, "POST", `${data}/query`, { database, query: "SELECT 1" })).status).toBe(403);
      expect((await api(tokens.read, "PATCH", `${data}/rows`, { ...cell, value: "x" })).status).toBe(403);
      const consoleToken = await tokenWith("console", ["projects.view", "console.access"]);
      expect((await ok(consoleToken, "POST", `${data}/query`, { database, query: "SELECT 1 AS one" })).result.rows).toEqual([["1"]]);
    }
  });

  it("browses Redis keys and refuses writes in read only mode", async () => {
    redisId = (
      await ok(ADMIN, "POST", "/services", { type: "database", projectId: made.projectId, environmentId, name: "zz-e2e-redis", engine: "redis", deploy: true, ...SERVER }, 201)
    ).id;
    await until("redis running", async () => ((await ok(ADMIN, "GET", `/services/${redisId}`)).service.status === "running" ? true : null));
    const data = `/services/${redisId}/data`;
    const write = (query: string) => ok(ADMIN, "POST", `${data}/query`, { database: "0", query, readOnly: false });
    expect((await write(`HSET "zz:we'ird key" name Ada "f 2" "line\\nbreak"`)).result).toMatchObject({ kind: "value", value: "2" });
    await write("RPUSH zz:list a b c");
    const keys = await ok(ADMIN, "GET", `${data}/keys?database=0&pattern=${encodeURIComponent("zz:*")}`);
    expect(keys.keys.map((k: any) => [k.key, k.type, k.size]).sort()).toEqual([
      ["zz:list", "list", 3],
      ["zz:we'ird key", "hash", 2],
    ]);
    const key = (await ok(ADMIN, "GET", `${data}/key?database=0&key=${encodeURIComponent("zz:we'ird key")}`)).key;
    expect(key).toMatchObject({ type: "hash", ttl: -1, size: 2 });
    expect(key.entries.sort()).toEqual([
      ["f 2", "line\nbreak"],
      ["name", "Ada"],
    ]);
    expect((await ok(ADMIN, "POST", `${data}/query`, { database: "0", query: "LRANGE zz:list 0 -1" })).result.value).toBe(JSON.stringify(["a", "b", "c"], null, 2));
    for (const refused of ["DEL zz:list", "FLUSHALL", "CONFIG GET requirepass", "SET zz:x 1"]) {
      const r = await api(ADMIN, "POST", `${data}/query`, { database: "0", query: refused });
      // Refused in this mode: 403, like any action the caller may not take.
      expect(r.status, refused).toBe(403);
      expect(r.json.error).toMatch(/read only mode/);
    }
    expect((await ok(ADMIN, "POST", `${data}/query`, { database: "0", query: "EXISTS zz:list" })).result.value).toBe("1");
  });

  it("backs up a database and restores it", async () => {
    const psql = (q: string) => `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "${q}"`;
    expect((await runCommand(dbId, psql("create table zz_e2e (v text); insert into zz_e2e values ('before')"))).exitCode).toBe(0);
    await ok(ADMIN, "POST", `/services/${dbId}/backups`, {}, 202);
    const backup = await until("backup", async () => {
      const b = (await ok(ADMIN, "GET", `/services/${dbId}/backups`)).backups[0];
      return b && b.status !== "running" ? b : null;
    });
    expect(backup.status).toBe("success");
    await runCommand(dbId, psql("update zz_e2e set v = 'after'"));
    expect((await runCommand(dbId, psql("select v from zz_e2e"))).output).toContain("after");
    await ok(ADMIN, "POST", `/backups/${backup.id}/restore`, { backupFirst: false }, 202);
    await until("restore", async () => {
      const b = (await ok(ADMIN, "GET", `/services/${dbId}/backups`)).backups.find((x: any) => x.id === backup.id);
      return b?.restoreStatus && b.restoreStatus !== "running" ? b.restoreStatus : null;
    });
    await until("database back after restore", async () => ((await ok(ADMIN, "GET", `/services/${dbId}`)).service.status === "running" ? true : null));
    expect((await runCommand(dbId, psql("select v from zz_e2e"))).output).toContain("before");
  });

  it("branches a database", async () => {
    await ok(ADMIN, "POST", `/services/${dbId}/branches`, { name: "dev" }, 202);
    const branch = await until("branch", async () => {
      const b = (await ok(ADMIN, "GET", `/services/${dbId}/branches`)).branches.find((x: any) => x.name === "dev");
      return b && b.status !== "creating" && b.status !== "resetting" ? b : null;
    });
    expect(branch.status).toBe("ready");
    await ok(ADMIN, "DELETE", `/branches/${branch.id}`);
  });

  it("hides personal data in a branch, also after a reset", async () => {
    const psql = (q: string, db = '"$POSTGRES_DB"') => `psql -U "$POSTGRES_USER" -d ${db} -tAc "${q}"`;
    await runCommand(dbId, psql("create table if not exists zz_people (email text); insert into zz_people values ('real@person.example')"));
    await ok(ADMIN, "PUT", `/services/${dbId}/branches/cleanup-sql`, { sql: "UPDATE zz_people SET email = 'hidden@example.com';" });
    await ok(ADMIN, "POST", `/services/${dbId}/branches`, { name: "safe", hidePersonalData: true }, 202);
    const ready = async () =>
      until("hidden branch", async () => {
        const b = (await ok(ADMIN, "GET", `/services/${dbId}/branches`)).branches.find((x: any) => x.name === "safe");
        return b && b.status !== "creating" && b.status !== "resetting" ? b : null;
      });
    let branch = await ready();
    expect(branch.status).toBe("ready");
    expect(branch.personalDataHidden).toBe(true);
    const inBranch = () => runCommand(dbId, psql("select email from zz_people", branch.database));
    expect((await inBranch()).output).toContain("hidden@example.com");
    expect((await runCommand(dbId, psql("select email from zz_people"))).output).toContain("real@person.example");
    // A reset copies the real data again, and hides it again.
    await ok(ADMIN, "POST", `/branches/${branch.id}/reset`, undefined, 202);
    await new Promise((r) => setTimeout(r, 1500));
    branch = await ready();
    expect((await inBranch()).output).toContain("hidden@example.com");
    // A branch of this branch copies its data (a row only it has), and hides personal data too.
    await runCommand(dbId, psql("insert into zz_people values ('only-in-safe@example.com')", branch.database));
    await ok(ADMIN, "POST", `/services/${dbId}/branches`, { name: "child", sourceBranchId: branch.id }, 202);
    const child = await until("child branch", async () => {
      const b = (await ok(ADMIN, "GET", `/services/${dbId}/branches`)).branches.find((x: any) => x.name === "child");
      return b && b.status !== "creating" && b.status !== "resetting" ? b : null;
    });
    expect(child.status).toBe("ready");
    expect(child.sourceBranchId).toBe(branch.id);
    expect(child.personalDataHidden).toBe(true);
    // Two rows (the main data has one), both hidden again by the clean-up SQL.
    expect((await runCommand(dbId, psql("select count(*) from zz_people", child.database))).output.trim()).toBe("2");
    expect((await runCommand(dbId, psql("select count(*) from zz_people"))).output.trim()).toBe("1");
    expect((await runCommand(dbId, psql("select email from zz_people", child.database))).output).not.toContain("only-in-safe");
    await ok(ADMIN, "DELETE", `/branches/${child.id}`);
    await ok(ADMIN, "DELETE", `/branches/${branch.id}`);
  });

  it("reaches and balances apps on this machine's 127.0.0.1 from a custom proxy file", async () => {
    const proxyUrl = process.env.SERVE_E2E_PROXY_URL;
    if (!proxyUrl || process.env.SERVE_E2E_SERVER) return;
    // Two apps on loopback only: the proxy container could not reach them without the relay.
    const apps = [0, 1].map((i) => http.createServer((req, res) => res.end(`app${i} saw ${req.headers.host}`)));
    await Promise.all(apps.map((a) => new Promise<void>((resolve) => a.listen(0, "127.0.0.1", resolve))));
    const ports = apps.map((a) => (a.address() as { port: number }).port);
    const name = "zz-e2e-host-port.conf";
    const host = "zz-e2e-host-port.test";
    // fetch() leaves out a Host header it is given: a plain request sends it.
    const get = () =>
      new Promise<string>((resolve) => {
        const req = http.get(proxyUrl, { headers: { host, connection: "close" } }, (r) => {
          let data = "";
          r.on("data", (c) => (data += c));
          r.on("end", () => resolve(r.statusCode === 200 ? data : `HTTP ${r.statusCode}`));
        });
        req.on("error", () => resolve(""));
      });
    const tally = async (n: number) => {
      const seen: Record<string, number> = {};
      for (let i = 0; i < n; i++) {
        const r = await get();
        seen[r] = (seen[r] ?? 0) + 1;
      }
      return seen;
    };
    try {
      await ok(ADMIN, "PUT", `/servers/local/proxy/files/${name}`, {
        content: `upstream zz_e2e_host {\n    server 127.0.0.1:${ports[0]} max_fails=1 fail_timeout=10s;\n    server localhost:${ports[1]} max_fails=1 fail_timeout=10s;\n}\nserver {\n    listen 80;\n    server_name ${host};\n    location / {\n        proxy_pass http://zz_e2e_host;\n        proxy_set_header Host $host;\n    }\n}\n`,
      });
      await until("host port relay", async () => ((await get()).startsWith("app") ? true : null), 60_000);
      const both = await tally(20);
      expect(both[`app0 saw ${host}`]).toBeGreaterThan(0);
      expect(both[`app1 saw ${host}`]).toBeGreaterThan(0);
      // One app stops: every request still gets an answer, from the other.
      await new Promise((resolve) => apps[1].close(resolve));
      expect(await tally(20)).toEqual({ [`app0 saw ${host}`]: 20 });
    } finally {
      await api(ADMIN, "DELETE", `/servers/local/proxy/files/${name}`);
      await Promise.all(apps.map((a) => new Promise((resolve) => a.close(() => resolve(null)))));
    }
  });

  it("keeps a token limited to its projects", async () => {
    if (!sql) return;
    const other = (await ok(ADMIN, "GET", "/projects")).projects.find((p: any) => p.id !== made.projectId);
    const limited = await tokenWith("limited", ["admin"], [made.projectId]);
    const list = (await ok(limited, "GET", "/projects")).projects;
    expect(list.map((p: any) => p.id)).toEqual([made.projectId]);
    if (other) expect((await api(limited, "GET", `/projects/${other.id}`)).status).toBe(404);
    expect((await ok(limited, "GET", "/services")).services.every((s: any) => s.projectId === made.projectId)).toBe(true);
  });

  it("deletes what it made", async () => {
    await ok(ADMIN, "DELETE", `/services/${appId}?volumes=true`);
    await ok(ADMIN, "DELETE", `/services/${dbId}?volumes=true`);
    await ok(ADMIN, "DELETE", `/services/${redisId}?volumes=true`);
    appId = "";
    dbId = "";
    redisId = "";
    await new Promise((r) => setTimeout(r, 3000));
    await ok(ADMIN, "DELETE", `/projects/${made.projectId}`);
    expect((await api(ADMIN, "GET", `/projects/${made.projectId}`)).status).toBe(404);
    made.projectId = "";
  });
});
