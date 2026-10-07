import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, describe, expect, it, vi } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-backups-"));
process.env.SERVE_DATA_DIR = dataDir;
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const state = vi.hoisted(() => ({ rows: [] as { filename: string | null }[], logs: [] as unknown[] }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => state.rows }) }),
    update: () => ({ set: (v: unknown) => ({ where: async () => void state.logs.push(v) }) }),
  },
  schema: new Proxy({}, { get: () => new Proxy({}, { get: (_t, col) => col }) }),
}));

const { checkIntegrity, fileSha256, importFilename, restoreName, takenFilenames, wrongEngine } = await import("@/server/backups");

const file = (name: string, content: string | Buffer, gz = false) => {
  const p = path.join(dataDir, name);
  fs.writeFileSync(p, gz ? zlib.gzipSync(content) : content);
  return p;
};

describe("wrongEngine", () => {
  const mysqlDump = "-- MySQL dump 10.13  Distrib 8.0.36\n--\n-- Host: localhost\n";
  const mariaDump = "/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;\nCREATE TABLE t (n int);\n";
  const pgDump = "--\n-- PostgreSQL database dump\n--\nSET statement_timeout = 0;\n";
  const pgCluster = "--\n-- PostgreSQL database cluster dump\n--\n";

  it("refuses a MySQL or MariaDB dump for PostgreSQL, plain or gzipped", async () => {
    expect(await wrongEngine("postgres", file("m.sql", mysqlDump), false)).toMatch(/MySQL or MariaDB dump/);
    expect(await wrongEngine("postgres", file("m.sql.gz", mysqlDump, true), true)).toMatch(/MySQL or MariaDB dump/);
    expect(await wrongEngine("postgres", file("ma.sql", mariaDump), false)).toMatch(/MySQL or MariaDB dump/);
  });

  it("refuses a PostgreSQL dump for MySQL and MariaDB, naming the engine", async () => {
    expect(await wrongEngine("mysql", file("p.sql", pgDump), false)).toMatch(/database is MySQL\./);
    expect(await wrongEngine("mariadb", file("pc.sql.gz", pgCluster, true), true)).toMatch(/database is MariaDB\./);
    expect(await wrongEngine("mysql", file("p.dump", Buffer.concat([Buffer.from("PGDMP"), crypto.randomBytes(64)])), false)).toMatch(/PostgreSQL dump/);
  });

  it("lets matching dumps, and MySQL and MariaDB each other's, through", async () => {
    expect(await wrongEngine("postgres", file("p2.sql", pgDump), false)).toBeNull();
    expect(await wrongEngine("mariadb", file("m2.sql", mysqlDump), false)).toBeNull();
    expect(await wrongEngine("mysql", file("ma2.sql", mariaDump), false)).toBeNull();
  });

  it("never blocks on what it cannot read or other engines", async () => {
    expect(await wrongEngine("postgres", file("unknown.sql", "CREATE TABLE t (n int);\n"), false)).toBeNull();
    // Not gzip though it says so, and a missing file: let the restore report the real error.
    expect(await wrongEngine("postgres", file("bad.sql.gz", mysqlDump.slice(0, 5)), true)).toBeNull();
    expect(await wrongEngine("postgres", path.join(dataDir, "missing.sql"), false)).toBeNull();
    expect(await wrongEngine("mongodb", file("x.sql", mysqlDump), false)).toBeNull();
  });
});

describe("restoreName", () => {
  it("allows ordinary database names", () => {
    for (const n of ["app", "app_db", "App-2", "_x", "a$b", "a".repeat(63)]) expect(restoreName(n)).toBe(true);
  });
  it("refuses engines' own databases, quoting and path tricks, and overlong names", () => {
    for (const n of ["", "postgres", "template1", "mysql", "information_schema", "admin", "a".repeat(64), "-x", "$x", 'a"b', "a`b", "a'b", "a b", "a;b", "../x", "a\nb"])
      expect(restoreName(n)).toBe(false);
  });
});

describe("import file names", () => {
  it("keeps only the base name in safe characters", () => {
    expect(importFilename("postgres", "app", "../../etc/My Dump (1).SQL", new Set())).toBe("my-dump--1-.sql");
    expect(importFilename("mysql", "app", "/tmp/$(id);x.sql.gz", new Set())).toBe("--id--x.sql.gz");
  });
  it("takes encrypted files of an allowed type", () => {
    expect(importFilename("postgres", "app", "db.dump.enc", new Set())).toBe("db.dump.enc");
    expect(() => importFilename("postgres", "app", "db.enc")).toThrow(/Upload a/);
    expect(() => importFilename("redis", "app", "dump.sql")).toThrow(/Upload a \.rdb file/);
  });
  it("never takes the name of an existing backup", () => {
    const taken = new Set(["db.sql"]);
    const name = importFilename("postgres", "my-app", "db.sql", taken);
    expect(name).not.toBe("db.sql");
    expect(name).toMatch(/^my-app-import-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-db\.sql$/);
  });
});

describe("takenFilenames", () => {
  it("joins listed backups and files on disk, skipping backups without a file", async () => {
    fs.mkdirSync(path.join(dataDir, "backups", "svc1"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "backups", "svc1", "on-disk.sql"), "");
    state.rows = [{ filename: "listed.sql" }, { filename: null }];
    expect([...(await takenFilenames("svc1"))].sort()).toEqual(["listed.sql", "on-disk.sql"]);
  });
  it("works for a service without a backup folder yet", async () => {
    state.rows = [];
    expect(await takenFilenames("no-such-service")).toEqual(new Set());
  });
});

describe("checksums", () => {
  const content = crypto.randomBytes(300_000);
  const p = file("c.bin", content);
  const sha = crypto.createHash("sha256").update(content).digest("hex");

  it("hashes the whole file", async () => {
    expect(await fileSha256(p)).toBe(sha);
  });
  it("passes an intact file and logs it, fails a damaged one, skips backups without a checksum", async () => {
    state.logs = [];
    await expect(checkIntegrity({ id: "b1", checksum: sha }, p)).resolves.toBeUndefined();
    expect(state.logs).toHaveLength(1);
    const damaged = Buffer.from(content);
    damaged[1000] ^= 1;
    await expect(checkIntegrity({ id: "b1", checksum: sha }, file("d.bin", damaged))).rejects.toThrow(/damaged/);
    await expect(checkIntegrity({ id: "b1", checksum: sha }, file("short.bin", content.subarray(0, 1000)))).rejects.toThrow(/damaged/);
    await expect(checkIntegrity({ id: "b1", checksum: null }, file("other.bin", "x"))).resolves.toBeUndefined();
  });
});
