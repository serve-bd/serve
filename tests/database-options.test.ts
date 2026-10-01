import { describe, expect, it } from "vitest";
import { databaseConfigIssues, databasePlan, databaseUrl, pgConfigArgs, splitArgs, TLS_DIR } from "@/server/databases/options";
import { changePasswordCommand } from "@/server/databases/password";
import { createSpec, mountBinds } from "@/server/deploy/containers";
import { defaultRuntime, type DatabaseConfig } from "@/server/services/types";

const pg = (extra: Partial<DatabaseConfig> = {}): DatabaseConfig => ({
  engine: "postgres",
  version: "17-alpine",
  username: "postgres",
  password: "enc",
  database: "app",
  backupRetention: 7,
  ...extra,
});
const redis = (extra: Partial<DatabaseConfig> = {}): DatabaseConfig => ({ ...pg(), engine: "redis", version: "8-alpine", username: "default", database: "0", ...extra });

describe("database plan", () => {
  it("keeps the image defaults for a plain config", () => {
    const plan = databasePlan(pg(), "secret", "/data/services/s1");
    expect(plan.image).toBe("postgres:17-alpine");
    expect(plan.cmd).toBeUndefined();
    expect(plan.binds).toEqual([]);
    expect(plan.dataMountPath).toBe("/var/lib/postgresql/data");
    expect(plan.env.POSTGRES_PASSWORD).toBe("secret");
  });

  it("uses a custom image of the same family", () => {
    expect(databasePlan(pg({ image: "pgvector/pgvector:pg17" }), "x", "/d").image).toBe("pgvector/pgvector:pg17");
    expect(databaseConfigIssues(pg({ image: "pgvector/pgvector:pg17" }))).toEqual([]);
    expect(databaseConfigIssues(pg({ image: "timescale/timescaledb:latest-pg17" }))).toEqual([]);
    expect(databaseConfigIssues(pg({ image: "redis:7" }))[0]).toMatch(/does not look like a PostgreSQL image/);
  });

  it("turns postgresql.conf lines into -c arguments", () => {
    expect(pgConfigArgs("max_connections = 200\n# comment\nshared_buffers='256MB'  # inline")).toEqual(["-c", "max_connections=200", "-c", "shared_buffers=256MB"]);
    expect(() => pgConfigArgs("nonsense")).toThrow(/Line 1/);
    const plan = databasePlan(pg({ customConfig: "max_connections = 50", extraArgs: "-c log_statement=all" }), "x", "/d");
    expect(plan.cmd).toEqual(["postgres", "-c", "max_connections=50", "-c", "log_statement=all"]);
  });

  it("sets initdb options and mounts init scripts", () => {
    const plan = databasePlan(
      pg({ initdbArgs: "--data-checksums", hostAuthMethod: "scram-sha-256", initScripts: [{ name: "01-schema.sql", content: "create table t();" }] }),
      "x",
      "/d/s",
    );
    expect(plan.env.POSTGRES_INITDB_ARGS).toBe("--data-checksums");
    expect(plan.env.POSTGRES_HOST_AUTH_METHOD).toBe("scram-sha-256");
    expect(plan.binds).toContain("/d/s/initdb:/docker-entrypoint-initdb.d:ro");
    expect(plan.files).toEqual([{ path: "/d/s/initdb/01-schema.sql", content: "create table t();", mode: 0o644 }]);
    expect(plan.resetDirs).toEqual(["/d/s/initdb"]);
  });

  it("wraps the start command to hand TLS keys to the server user", () => {
    const plan = databasePlan(pg({ tls: { enabled: true, mode: "require" } }), "x", "/d/s");
    expect(plan.tls).toBe(true);
    expect(plan.binds).toContain("/d/s/tls:/etc/serve-tls:ro");
    expect(plan.cmd?.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(plan.cmd?.[2]).toContain("chown -R postgres");
    expect(plan.cmd?.slice(3)).toEqual([
      "sh",
      "postgres",
      "-c",
      "ssl=on",
      "-c",
      `ssl_cert_file=${TLS_DIR}/server.crt`,
      "-c",
      `ssl_key_file=${TLS_DIR}/server.key`,
      "-c",
      `ssl_ca_file=${TLS_DIR}/ca.crt`,
    ]);
    expect(databaseUrl(pg({ tls: { enabled: true, mode: "require" } }), plan.creds, "db", 5432)).toMatch(/\?sslmode=require$/);
  });

  it("puts the redis config file first and switches clients to TLS", () => {
    const plan = databasePlan(redis({ customConfig: "maxmemory 64mb" }), "pw", "/d/s");
    expect(plan.cmd).toEqual(["redis-server", "/etc/serve/redis.conf", "--requirepass", "pw", "--appendonly", "yes"]);
    expect(plan.files[0]).toMatchObject({ path: "/d/s/config/redis.conf", content: "maxmemory 64mb\n" });
    // Optional TLS: the private network stays plain on 6379, TLS on 6380 is what the public port leads to.
    const tls = databasePlan(redis({ tls: { enabled: true } }), "pw", "/d/s");
    expect(tls.creds.tlsRequired).toBe(false);
    expect(tls.cmd).toContain("6380");
    expect(tls.cmd).not.toContain("0");
    expect(tls.publicTarget).toBe(6380);
    expect(databaseUrl(redis({ tls: { enabled: true } }), tls.creds, "r", 6379)).toMatch(/^redis:/);
    expect(databaseUrl(redis({ tls: { enabled: true } }), tls.creds, "db.example.com", 16379, { public: true })).toMatch(/^rediss:/);
    // Required TLS: TLS only, on 6379, for every client.
    const required = databasePlan(redis({ tls: { enabled: true, mode: "require" } }), "pw", "/d/s");
    expect(required.creds.tlsRequired).toBe(true);
    expect(required.healthcheck[1]).toContain("--tls --insecure");
    expect(required.publicTarget).toBe(6379);
    expect(databaseUrl(redis({ tls: { enabled: true, mode: "require" } }), required.creds, "r", 6379)).toMatch(/^rediss:/);
  });

  it("turns on ClickHouse TLS with a config file and the image's own command", () => {
    const cfg = { ...pg(), engine: "clickhouse" as const, version: "25.8-alpine", username: "default", database: "default", tls: { enabled: true } };
    const plan = databasePlan(cfg, "pw", "/d/s");
    expect(plan.files.find((f) => f.path === "/d/s/config/serve-tls.xml")?.content).toContain("<https_port>8443</https_port>");
    expect(plan.binds).toContain("/d/s/config/serve-tls.xml:/etc/clickhouse-server/config.d/serve-tls.xml:ro");
    expect(plan.cmd?.[0]).toBe("sh");
    expect(plan.cmd?.[2]).toContain("exec /entrypoint.sh");
    expect(plan.publicTarget).toBe(8443);
    expect(databasePlan({ ...cfg, tls: null }, "pw", "/d/s").publicTarget).toBe(8123);
  });

  it("asks public clients to verify a trusted certificate", () => {
    const cfg = pg({ tls: { enabled: true } });
    const creds = databasePlan(cfg, "pw", "/d").creds;
    expect(databaseUrl(cfg, creds, "app-db", 5432)).toMatch(/sslmode=prefer$/);
    expect(databaseUrl(cfg, creds, "db.example.com", 15432, { public: true })).toMatch(/sslmode=require$/);
    expect(databaseUrl(cfg, creds, "db.example.com", 15432, { public: true, verified: true })).toMatch(/:15432\/app\?sslmode=verify-full$/);
  });

  it("adds a [mysqld] section to MySQL config when missing", () => {
    const plan = databasePlan({ ...pg(), engine: "mysql", version: "8.4", username: "app", customConfig: "max_connections=300", charset: "utf8mb4" }, "pw", "/d");
    expect(plan.files[0].content).toBe("[mysqld]\nmax_connections=300\n");
    expect(plan.cmd).toEqual(["mysqld", "--character-set-server=utf8mb4"]);
  });

  it("applies health check timing", () => {
    const plan = databasePlan(pg({ healthcheck: { interval: 2, retries: 30 } }), "x", "/d");
    expect(plan.health).toEqual({ interval: 2, timeout: 5, retries: 30, startPeriod: 10 });
    const spec = createSpec({
      name: "n",
      image: "i",
      slug: "s",
      serviceId: "id",
      kind: "database",
      env: {},
      runtime: defaultRuntime(),
      aliases: [],
      network: "net",
      healthcheck: plan.healthcheck,
      healthTiming: plan.health,
    });
    expect(spec.Healthcheck).toMatchObject({ Interval: 2e9, Retries: 30, Timeout: 5e9 });
  });

  it("rejects bad scripts and args", () => {
    expect(databaseConfigIssues(pg({ initScripts: [{ name: "../x.sql", content: "" }] }))[0]).toMatch(/Script name/);
    expect(databaseConfigIssues(pg({ extraArgs: "-c 'unclosed" }))[0]).toMatch(/unclosed quote/);
    expect(databaseConfigIssues(redis({ initScripts: [{ name: "a.sql", content: "" }] }))[0]).toMatch(/does not run initialization scripts/);
  });
});

describe("splitArgs", () => {
  it("honors quotes", () => {
    expect(splitArgs(`--a=1 "b c" 'd e' f\\ g ""`)).toEqual(["--a=1", "b c", "d e", "f g", ""]);
  });
});

describe("password change", () => {
  it("escapes quotes for SQL and shell", () => {
    const cmd = changePasswordCommand(pg(), { username: "postgres", password: "old", database: "app" }, "new-pass_123.x");
    expect(cmd).toContain(`-c 'ALTER USER "postgres" WITH PASSWORD '\\''new-pass_123.x'\\'''`);
    expect(changePasswordCommand({ ...pg(), engine: "clickhouse" }, { username: "d", password: "o", database: "d" }, "n")).toBeNull();
  });
});

describe("mounts", () => {
  it("builds binds for volumes, host paths and files", () => {
    expect(
      mountBinds(
        "app",
        [
          { kind: "volume", source: "data", mountPath: "/data" },
          { kind: "bind", source: "/srv/x", mountPath: "/x", readOnly: true },
          { kind: "file", source: "app.conf", mountPath: "/etc/app.conf", content: "a=1" },
        ],
        "/d/services/s1",
      ),
    ).toEqual(["serve-app-data:/data", "/srv/x:/x:ro", "/d/services/s1/files/app.conf:/etc/app.conf"]);
  });
});
