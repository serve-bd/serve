import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {}, schema: {} }));
import { databasePlan, databaseUrl, mongoReplicaKey } from "@/server/databases/options";
import { replicaSpec, replicationPassword } from "@/server/databases/replica-engines";
import type { DatabaseConfig, DbEngine } from "@/server/services/types";
import { replicaInstances, replicasSupported } from "@/server/services/types";

const cfg = (engine: DbEngine, extra: Partial<DatabaseConfig> = {}): DatabaseConfig =>
  ({ engine, version: "x", username: engine === "mongodb" ? "root" : "app", database: "app", password: null, backupRetention: 7, ...extra }) as DatabaseConfig;
const service = (database: DatabaseConfig) => ({ id: "svc", slug: "db-abc", serverId: "local", database }) as never;
const server = { paths: { service: () => "/srv/svc" } } as never;
const bashParses = (script: string) => execFileSync("bash", ["-n", "-c", script], { encoding: "utf8" });

describe("which engines have replicas", () => {
  it("is every engine but ClickHouse", () => {
    for (const e of ["postgres", "mysql", "mariadb", "mongodb", "redis", "valkey"] as const) expect(replicasSupported(e)).toBe(true);
    expect(replicasSupported("clickhouse")).toBe(false);
    expect(replicaInstances({ serverId: "s", database: cfg("clickhouse", { replica: { enabled: true } }) })).toEqual([]);
    expect(replicaInstances({ serverId: "s", database: cfg("redis", { replica: { enabled: true } }) })).toEqual([{ id: "1", serverId: "s" }]);
  });
});

describe("the database's settings for replicas", () => {
  it("turns on MariaDB's binary log and MongoDB's replica set only once primed", () => {
    expect(databasePlan(cfg("mariadb"), "pw", "/d").cmd).toBeUndefined();
    expect(databasePlan(cfg("mariadb", { replica: { enabled: true, primed: true } }), "pw", "/d").cmd).toEqual(expect.arrayContaining(["--log-bin=mysql-bin", "--server-id=1"]));
    const mongo = databasePlan(cfg("mongodb", { replica: { enabled: true, primed: true } }), "pw", "/d");
    expect(mongo.cmd?.join(" ")).toContain("--replSet rs0 --keyFile /run/serve-mongo/key");
    expect(mongo.env.SERVE_MONGO_KEY).toBe(mongoReplicaKey("pw"));
  });

  it("gives MongoDB URLs directConnection once it is a replica set, and reads go to replicas", () => {
    const creds = { username: "root", password: "pw", database: "app" };
    expect(databaseUrl(cfg("mongodb"), creds, "h", 27017)).not.toContain("directConnection");
    const primed = cfg("mongodb", { replica: { enabled: true, primed: true } });
    expect(databaseUrl(primed, creds, "h", 27017)).toMatch(/directConnection=true$/);
    expect(databaseUrl(primed, creds, "h-replica", 27017, { replica: true })).toMatch(/directConnection=true&readPreference=secondaryPreferred$/);
  });
});

describe("replica containers", () => {
  it("make Redis and Valkey follow the database, read-only", () => {
    const spec = replicaSpec(service(cfg("redis")), "1", server, "rp", null);
    expect(spec.cmd.join(" ")).toContain("--replicaof db-abc 6379");
    expect(spec.cmd).toEqual(expect.arrayContaining(["--replica-read-only", "yes"]));
  });

  it("copy MySQL with a retrying start, its own server id and a valid bash script", () => {
    const spec = replicaSpec(service(cfg("mysql")), "3", server, "x".repeat(48), null);
    expect(spec.cmd[0]).toBe("sh");
    expect(spec.cmd).toEqual(expect.arrayContaining(["docker-entrypoint.sh", "--server-id=1003", "--read-only=ON"]));
    expect(spec.env.REPLICA_PASSWORD).toHaveLength(32);
    const script = spec.files.find((f) => f.path.endsWith("serve-replica.sh"))!.content;
    expect(script.startsWith("#!/bin/bash\nset -eo pipefail")).toBe(true);
    expect(() => bashParses(script)).not.toThrow();
    expect(spec.binds).toContain("/srv/svc/replica-3-init:/docker-entrypoint-initdb.d:ro");
  });

  it("copy MariaDB without its health check login and checks health as root", () => {
    const spec = replicaSpec(service(cfg("mariadb", { replica: { enabled: true, primed: true } })), "1", server, "p", null);
    const script = spec.files.find((f) => f.path.endsWith("serve-replica.sh"))!.content;
    expect(script).toContain(".healthcheck.@");
    expect(script).toContain("REVOKE READ_ONLY ADMIN");
    expect(() => bashParses(script)).not.toThrow();
    expect(spec.healthcheck.join(" ")).toContain("mariadb-admin ping");
    // The replica's own server id comes after the database's (the last one wins).
    expect(spec.cmd.lastIndexOf("--server-id=1001")).toBeGreaterThan(spec.cmd.lastIndexOf("--server-id=1"));
  });

  it("start MongoDB members empty, with the set's key", () => {
    const spec = replicaSpec(service(cfg("mongodb", { replica: { enabled: true, primed: true } })), "1", server, "p", null);
    expect(spec.env.MONGO_INITDB_ROOT_USERNAME).toBeUndefined();
    expect(spec.env.SERVE_MONGO_KEY).toBeTruthy();
    expect(spec.cmd.join(" ")).toContain("--replSet rs0");
  });

  it("leave the database's own init scripts out", () => {
    const spec = replicaSpec(service(cfg("mysql", { initScripts: [{ name: "a.sql", content: "select 1" }] })), "1", server, "p", null);
    expect(spec.binds.some((b) => b.startsWith("/srv/svc/initdb:"))).toBe(false);
    expect(spec.files.some((f) => f.path.includes("/initdb/"))).toBe(false);
  });

  it("keep replication passwords within MySQL's 32 characters", () => {
    expect(replicationPassword("mysql", "a".repeat(48))).toHaveLength(32);
    expect(replicationPassword("redis", "a".repeat(48))).toHaveLength(48);
  });
});
