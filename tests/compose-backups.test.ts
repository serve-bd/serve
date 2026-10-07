import { describe, expect, it } from "vitest";
import { composeDatabases, credsFromEnv, dumpCommands, engineOfImage, parseBackupKey, requirePass } from "@/server/backups/compose";

describe("compose backups", () => {
  it("recognizes database images", () => {
    expect(engineOfImage("postgres:16-alpine")).toBe("postgres");
    expect(engineOfImage("pgvector/pgvector:pg17")).toBe("postgres");
    expect(engineOfImage("ghcr.io/immich-app/postgres:14-vectorchord0.4.3")).toBe("postgres");
    expect(engineOfImage("bitnami/postgresql:16")).toBe("postgres");
    expect(engineOfImage("mariadb:11")).toBe("mariadb");
    expect(engineOfImage("mysql:8.4")).toBe("mysql");
    expect(engineOfImage("mongo:7")).toBe("mongodb");
    expect(engineOfImage("redis:7-alpine")).toBe("redis");
    expect(engineOfImage("valkey/valkey:8")).toBe("valkey");
    expect(engineOfImage("mattermost/mattermost-team-edition:10")).toBeNull();
    expect(engineOfImage("postgrest/postgrest")).toBeNull();
    expect(engineOfImage("prometheuscommunity/postgres-exporter")).toBeNull();
    expect(engineOfImage("prodrigestivill/postgres-backup-local:16")).toBeNull();
    expect(engineOfImage("redisinsight")).toBeNull();
    expect(engineOfImage("clickhouse/clickhouse-server:24.8")).toBe("clickhouse");
    expect(engineOfImage("clickhouse:25")).toBe("clickhouse");
    expect(engineOfImage("bitnami/clickhouse:24")).toBe("clickhouse");
    expect(engineOfImage("clickhouse/clickhouse-keeper:24.8")).toBeNull();
  });

  it("reads ClickHouse credentials of the official and Bitnami images", () => {
    expect(credsFromEnv("clickhouse", { CLICKHOUSE_USER: "app", CLICKHOUSE_PASSWORD: "pw", CLICKHOUSE_DB: "events" })).toMatchObject({
      username: "app",
      password: "pw",
      database: "events",
    });
    expect(credsFromEnv("clickhouse", { CLICKHOUSE_ADMIN_USER: "admin", CLICKHOUSE_ADMIN_PASSWORD: "pw2" })).toMatchObject({
      username: "admin",
      password: "pw2",
      database: "default",
    });
    expect(credsFromEnv("clickhouse", {})).toMatchObject({ username: "default", database: "default" });
  });

  it("lists the databases of a compose file", () => {
    const content = "services:\n  app:\n    image: ghost:5\n  db:\n    image: mysql:8\n  cache:\n    image: redis:7\n";
    expect(composeDatabases(content).map((d) => `${d.service}:${d.engine}`)).toEqual(["db:mysql", "cache:redis"]);
    expect(composeDatabases("not: [valid")).toEqual([]);
  });

  it("reads logins from the container environment", () => {
    expect(credsFromEnv("postgres", { POSTGRES_PASSWORD: "pw" })).toEqual({ username: "postgres", password: "pw", database: "postgres", root: true });
    expect(credsFromEnv("postgres", { POSTGRES_USER: "app", POSTGRES_DB: "appdb" }, { POSTGRES_PASSWORD_FILE: "secret\n" })).toMatchObject({
      username: "app",
      password: "secret",
      database: "appdb",
    });
    expect(credsFromEnv("mysql", { MYSQL_ROOT_PASSWORD: "r", MYSQL_DATABASE: "shop" })).toMatchObject({ username: "root", root: true });
    expect(credsFromEnv("mariadb", { MARIADB_USER: "u", MARIADB_PASSWORD: "p", MARIADB_DATABASE: "shop" })).toMatchObject({ username: "u", root: false });
    expect(credsFromEnv("mysql", { MYSQL_ROOT_PASSWORD: "r" })).toMatch(/MYSQL_DATABASE/);
  });

  it("quotes passwords in commands", () => {
    const c = dumpCommands("postgres", { username: "app", password: "it's $x", database: "db", root: false });
    expect(c.backup).toContain(`PGPASSWORD='it'\\''s $x'`);
    expect(dumpCommands("mysql", { username: "u", password: "p", database: "d", root: false }).backup).toContain("--no-tablespaces");
  });

  it("finds a redis password on the command line", () => {
    expect(requirePass(["redis-server", "--requirepass", "pw"])).toBe("pw");
    expect(requirePass(["sh", "-c", "redis-server --appendonly yes --requirepass 'pw2'"])).toBe("pw2");
    expect(requirePass(["redis-server", "--requirepass=pw3"])).toBe("pw3");
    expect(requirePass(["redis-server"])).toBe("");
  });

  it("parses backup keys", () => {
    expect(parseBackupKey("db:postgres")).toEqual({ kind: "db", name: "postgres" });
    expect(parseBackupKey("dir:/srv/a:b")).toEqual({ kind: "dir", name: "/srv/a:b" });
    expect(parseBackupKey("other:x")).toBeNull();
  });
});
