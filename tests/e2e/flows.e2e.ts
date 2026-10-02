// biome-ignore-all lint/suspicious/noExplicitAny: API answers are checked field by field in the tests.
import crypto from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/*
 * End-to-end tests of the main flows against a running Serve, through its API.
 *
 *   SERVE_E2E_URL=http://localhost:3000 \
 *   SERVE_E2E_TOKEN=srv_...            (an Admin token of an organization admin) \
 *   SERVE_E2E_DATABASE_URL=postgres://... (optional: the instance's database, for the permission tests) \
 *   pnpm test:e2e
 *
 * Everything the tests create is named zz-e2e-* and removed at the end. They deploy real
 * containers (nginx:alpine and postgres) on the organization's default server.
 */

const BASE = `${(process.env.SERVE_E2E_URL ?? "http://localhost:3000").replace(/\/$/, "")}/api/v1`;
const ADMIN = process.env.SERVE_E2E_TOKEN ?? "";
const DB_URL = process.env.SERVE_E2E_DATABASE_URL ?? "";
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
      await ok(ADMIN, "POST", "/services", { type: "app", projectId: made.projectId, environmentId, name: "zz-e2e-web", source: { type: "image", image: "nginx:alpine" } }, 201)
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
    dbId = (await ok(ADMIN, "POST", "/services", { type: "database", projectId: made.projectId, environmentId, name: "zz-e2e-pg", engine: "postgres", deploy: true }, 201)).id;
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
    appId = "";
    dbId = "";
    await new Promise((r) => setTimeout(r, 3000));
    await ok(ADMIN, "DELETE", `/projects/${made.projectId}`);
    expect((await api(ADMIN, "GET", `/projects/${made.projectId}`)).status).toBe(404);
    made.projectId = "";
  });
});
