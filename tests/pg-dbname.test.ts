import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {}, schema: {} }));
import { dumpCommands } from "@/server/backups/compose";
import { createScript } from "@/server/databases/branches";
import { engines, pgDbname } from "@/server/databases/engines";
import { userScripts } from "@/server/databases/users";

// A database named like connection options must reach psql, pg_dump and pg_restore as a name.
const NAMES = ["app", "host=evil port=1", "a'b", "back\\slash", "x' host='evil", 'q"uote'];

/** What libpq reads from a dbname='…' connection string (backslash escapes ' and \). */
const unquote = (conninfo: string) => {
  const m = /^dbname='((?:[^'\\]|\\.)*)'$/.exec(conninfo);
  return m ? m[1].replace(/\\(.)/g, "$1") : null;
};

const stubs = fs.mkdtempSync(path.join(os.tmpdir(), "serve-pgdbname-"));
afterAll(() => fs.rmSync(stubs, { recursive: true, force: true }));
// Stand-ins for the clients: a listing prints the databases, anything else logs the -d it got.
for (const name of ["psql", "pg_dump", "pg_restore"])
  fs.writeFileSync(
    path.join(stubs, name),
    `#!/bin/sh\ncat >/dev/null 2>&1 &\nlisting=\nwhile [ $# -gt 0 ]; do case "$1" in -At) listing=1;; -d) shift; printf '%s\\n' "$1" >> "$SERVE_STUB_LOG";; esac; shift; done\n[ -n "$listing" ] && printf '%s\\n' ${NAMES.map((n) => `'${n.replace(/'/g, `'\\''`)}'`).join(" ")}\nexit 0\n`,
    { mode: 0o755 },
  );
const run = (script: string) => {
  const log = path.join(stubs, `log-${Math.random()}`);
  const r = spawnSync("sh", ["-c", script], { encoding: "utf8", env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, SERVE_STUB_LOG: log } });
  expect(r.status, r.stderr).toBe(0);
  const got = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  fs.rmSync(log, { force: true });
  return got;
};

describe("PostgreSQL database names", () => {
  it("are connection strings naming only the database", () => {
    for (const n of NAMES) expect(unquote(pgDbname(n))).toBe(n);
    expect(pgDbname("host=evil")).toBe("dbname='host=evil'");
    expect(pgDbname("a'b\\c")).toBe("dbname='a\\'b\\\\c'");
  });

  it("reach every database of the Users page loop as names", () => {
    const main = { username: "postgres", password: "pw", database: "app" };
    const got = run(userScripts("postgres", main).remove("someone"));
    // The listing and the main database, then each listed database once.
    const looped = got.filter((d) => d !== pgDbname("app"));
    expect(looped.map(unquote).filter((n) => n !== "app")).toEqual(NAMES.filter((n) => n !== "app"));
    for (const d of got) expect(unquote(d)).not.toBeNull();
  });

  it("reach branch copies, backups and compose backups as names", () => {
    for (const n of NAMES) {
      const main = { username: "postgres", password: "pw", database: n };
      // The copy is named [a-z0-9_] (copyDatabaseName); the database copied may be named anyhow.
      const copy = run(createScript(main, { database: "x__b", username: "b", password: "bp" }, "SELECT 1;"));
      // pg_dump and pg_restore run side by side: their order varies.
      expect(copy.map(unquote).sort()).toEqual([n, n, n, "x__b", "x__b", "x__b"].sort());
      const pg = engines.postgres;
      const c = { username: "postgres", password: "pw", database: n };
      expect(run(pg.backupCommand(c)).map(unquote)).toEqual([n]);
      expect(run(pg.restoreCommand(c)).map(unquote)).toEqual([n]);
      expect(run(pg.backupDatabasesCommand!(c, [n, "other"]).command).map(unquote)).toEqual([n, "other"]);
      const compose = dumpCommands("postgres", { ...c, root: true });
      expect(run(compose.backup).map(unquote)).toEqual([n]);
    }
  });
});
