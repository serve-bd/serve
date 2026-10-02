import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  editCellScript,
  framed,
  kvCommandScript,
  kvKeyScript,
  kvKeyspaceScript,
  kvScanScript,
  mongoScript,
  parseChQuery,
  parseChRows,
  parseEditCount,
  parseKeyspace,
  parseKvKey,
  parseKvReply,
  parseKvScan,
  parseMongo,
  parseMyQuery,
  parseMyRows,
  parsePgQuery,
  parsePgRows,
  parseSqlOverview,
  parseSqlStructure,
  QUERY_TIMEOUT,
  readableEjson,
  sqlScripts,
  tokenizeCommand,
  unframe,
} from "@/server/databases/explorer";

/*
 * The Data tab's scripts against real database containers (all seven engines).
 *
 *   SERVE_EXPLORER_LIVE=1 pnpm vitest run tests/explorer-live.test.ts
 *
 * It starts containers named zz-explorer-* when they are not running, seeds them with awkward names
 * and values, and removes them at the end (SERVE_EXPLORER_KEEP=1 keeps them for another run).
 */

const live = process.env.SERVE_EXPLORER_LIVE ? describe : describe.skip;
vi.setConfig({ testTimeout: 120_000 });
const PASS = "zz-explorer-test-pass";
const creds = (username: string, database: string) => ({ username, password: PASS, database });

const CONTAINERS: Record<string, { image: string; args: string[]; ready: string }> = {
  "zz-explorer-pg": {
    image: "postgres:18-alpine",
    args: ["-e", "POSTGRES_USER=app", "-e", `POSTGRES_PASSWORD=${PASS}`, "-e", "POSTGRES_DB=app"],
    ready: `pg_isready -U app -d app -h 127.0.0.1`,
  },
  "zz-explorer-pg16": {
    image: "postgres:16",
    args: ["-e", "POSTGRES_USER=app", "-e", `POSTGRES_PASSWORD=${PASS}`, "-e", "POSTGRES_DB=app"],
    ready: `pg_isready -U app -d app -h 127.0.0.1`,
  },
  "zz-explorer-mysql": {
    image: "mysql:8.4",
    args: ["-e", `MYSQL_ROOT_PASSWORD=${PASS}`, "-e", "MYSQL_DATABASE=app", "-e", "MYSQL_USER=app", "-e", `MYSQL_PASSWORD=${PASS}`],
    ready: `MYSQL_PWD=${PASS} mysql -uroot -h 127.0.0.1 -e 'select 1'`,
  },
  "zz-explorer-mariadb": {
    image: "mariadb:11",
    args: ["-e", `MARIADB_ROOT_PASSWORD=${PASS}`, "-e", "MARIADB_DATABASE=app", "-e", "MARIADB_USER=app", "-e", `MARIADB_PASSWORD=${PASS}`],
    ready: `MYSQL_PWD=${PASS} mariadb -uroot -h 127.0.0.1 -e 'select 1'`,
  },
  "zz-explorer-mongo": {
    image: "mongo:8",
    args: ["-e", "MONGO_INITDB_ROOT_USERNAME=root", "-e", `MONGO_INITDB_ROOT_PASSWORD=${PASS}`],
    ready: `mongosh --quiet -u root -p ${PASS} --authenticationDatabase admin --eval 'db.adminCommand("ping").ok' | grep -q 1`,
  },
  "zz-explorer-redis": {
    image: "redis:7-alpine",
    args: ["redis-server", "--requirepass", PASS, "--appendonly", "yes"],
    ready: `REDISCLI_AUTH=${PASS} redis-cli --no-auth-warning ping | grep -q PONG`,
  },
  "zz-explorer-redis8": {
    image: "redis:8-alpine",
    args: ["redis-server", "--requirepass", PASS, "--appendonly", "yes"],
    ready: `REDISCLI_AUTH=${PASS} redis-cli --no-auth-warning ping | grep -q PONG`,
  },
  "zz-explorer-valkey": {
    image: "valkey/valkey:8-alpine",
    args: ["valkey-server", "--requirepass", PASS, "--appendonly", "yes"],
    ready: `REDISCLI_AUTH=${PASS} valkey-cli --no-auth-warning ping | grep -q PONG`,
  },
  "zz-explorer-ch": {
    image: "clickhouse/clickhouse-server:25.8-alpine",
    args: ["-e", "CLICKHOUSE_USER=default", "-e", `CLICKHOUSE_PASSWORD=${PASS}`, "-e", "CLICKHOUSE_DB=default", "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1"],
    ready: `clickhouse-client -u default --password ${PASS} -q 'SELECT 1'`,
  },
};

/** Runs a framed script in a container, like execCommand does (sh -c). */
function run(container: string, body: string[], timeoutSeconds = QUERY_TIMEOUT) {
  const nonce = crypto.randomBytes(6).toString("hex");
  const res = spawnSync("docker", ["exec", container, "sh", "-c", framed(body, nonce, timeoutSeconds)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = unframe(res.stdout + res.stderr);
  if (!out) throw new Error(`No answer from ${container}: ${res.stdout}${res.stderr}`);
  return out;
}
const ok = (container: string, body: string[]) => {
  const r = run(container, body);
  if (r.code !== 0) throw new Error(`${container} failed (${r.code}): ${r.stderr}`);
  return r;
};
/** Raw input for seeding, on stdin. */
const seed = (container: string, command: string, input: string) => {
  const r = spawnSync("docker", ["exec", "-i", container, "sh", "-c", command], { input, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`Seeding ${container} failed: ${r.stdout}${r.stderr}`);
  return r.stdout;
};

const WEIRD_TABLE = `we'ird"t\`a$(x)
ble`;
const WEIRD_COL = `na"me'\`$(id)`;
const WEIRD_VALUE = `line1\nline2\t,"q" 'x' \\ $(id) \`id\` é 😀`;

const created: string[] = [];

live("database explorer against real engines", () => {
  beforeAll(async () => {
    const running = execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" }).split("\n");
    for (const [name, c] of Object.entries(CONTAINERS)) {
      if (running.includes(name)) continue;
      spawnSync("docker", ["rm", "-f", name]);
      const isServer = c.args[0]?.endsWith("-server");
      const args = isServer ? ["run", "-d", "--name", name, c.image, ...c.args] : ["run", "-d", "--name", name, ...c.args, c.image];
      execFileSync("docker", args);
      created.push(name);
    }
    for (const [name, c] of Object.entries(CONTAINERS)) {
      const end = Date.now() + 120_000;
      while (spawnSync("docker", ["exec", name, "sh", "-c", c.ready]).status !== 0) {
        if (Date.now() > end) throw new Error(`${name} did not start`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    // MySQL answers before its init scripts finish: wait for the app database.
    for (const name of ["zz-explorer-mysql", "zz-explorer-mariadb"]) {
      const cli = name.endsWith("mysql") ? "mysql" : "mariadb";
      const end = Date.now() + 120_000;
      while (spawnSync("docker", ["exec", name, "sh", "-c", `MYSQL_PWD=${PASS} ${cli} -uroot app -e 'select 1'`]).status !== 0) {
        if (Date.now() > end) throw new Error(`${name} has no app database`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    const pg = `DROP SCHEMA IF EXISTS "we'ird" CASCADE; CREATE SCHEMA "we'ird";
CREATE TABLE "we'ird"."${WEIRD_TABLE.replace(/"/g, '""')}" (id bigint PRIMARY KEY, "${WEIRD_COL.replace(/"/g, '""')}" text, n numeric, j jsonb, b bytea, big bigint DEFAULT 9223372036854775807);
INSERT INTO "we'ird"."${WEIRD_TABLE.replace(/"/g, '""')}" VALUES (1, E'${WEIRD_VALUE.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}', 12345678901234567890.5, '{"a": 1}', '\\xdead00', DEFAULT), (2, '', NULL, NULL, NULL, NULL), (3, NULL, 1.5, '[1]', '\\x00', 1);
DROP TABLE IF EXISTS items; CREATE TABLE items (id serial PRIMARY KEY, name text NOT NULL, price int);
INSERT INTO items (name, price) SELECT 'item ' || g, g FROM generate_series(1, 120) g; CREATE INDEX items_name ON items (name); ANALYZE;`;
    for (const c of ["zz-explorer-pg", "zz-explorer-pg16"]) seed(c, `PGPASSWORD=${PASS} psql -X -q -v ON_ERROR_STOP=1 -U app -d app`, pg);

    const my = `DROP TABLE IF EXISTS \`${WEIRD_TABLE.replace(/`/g, "``")}\`;
CREATE TABLE \`${WEIRD_TABLE.replace(/`/g, "``")}\` (id bigint PRIMARY KEY, \`${WEIRD_COL.replace(/`/g, "``")}\` text, b varbinary(10), j json, n decimal(30,2), big bigint unsigned);
INSERT INTO \`${WEIRD_TABLE.replace(/`/g, "``")}\` VALUES (1, FROM_BASE64('${Buffer.from(WEIRD_VALUE).toString("base64")}'), 0xdead00, '{"a": 1}', 12345678901234567890.12, 18446744073709551615), (2, '', NULL, NULL, NULL, NULL), (3, 'NULL', 0x01, '[1]', 1.5, 1);
DROP TABLE IF EXISTS items; CREATE TABLE items (id int AUTO_INCREMENT PRIMARY KEY, name varchar(50) NOT NULL, price int, KEY k_name (name));
INSERT INTO items (name, price) WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 120) SELECT CONCAT('item ', n), n FROM s;
CREATE DATABASE IF NOT EXISTS \`other db\`;`;
    seed("zz-explorer-mysql", `MYSQL_PWD=${PASS} mysql -uroot --default-character-set=utf8mb4 app`, my);
    seed("zz-explorer-mariadb", `MYSQL_PWD=${PASS} mariadb -uroot --default-character-set=utf8mb4 app`, my);

    seed(
      "zz-explorer-ch",
      `clickhouse-client -u default --password ${PASS} --multiquery`,
      `DROP TABLE IF EXISTS \`${WEIRD_TABLE.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\`;
CREATE TABLE \`${WEIRD_TABLE.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\` (id UInt64, \`${WEIRD_COL.replace(/`/g, "\\`")}\` String, n Nullable(Int64), big UInt64, a Array(String)) ENGINE = MergeTree ORDER BY id;
INSERT INTO \`${WEIRD_TABLE.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\` VALUES (1, '${WEIRD_VALUE.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}', NULL, 18446744073709551615, ['x', 'y']), (2, '', 5, 0, []), (3, 'NULL', 10, 1, ['z']);
DROP TABLE IF EXISTS items; CREATE TABLE items (id UInt32, name String, price UInt32, INDEX idx_name name TYPE bloom_filter GRANULARITY 1) ENGINE = MergeTree ORDER BY id;
INSERT INTO items SELECT number + 1, concat('item ', toString(number + 1)), number + 1 FROM numbers(120);`,
    );

    seed(
      "zz-explorer-mongo",
      `mongosh --quiet -u root -p ${PASS} --authenticationDatabase admin app --file /dev/stdin`,
      `const d = db.getSiblingDB("app");
d.dropDatabase();
d.getCollection("we'ird.coll \\"x").insertMany([{ _id: 1, s: ${JSON.stringify(WEIRD_VALUE)}, big: NumberLong("9223372036854775807"), dt: new Date(0), dec: NumberDecimal("1.10"), bin: BinData(0, "3q0A") }, { _id: 2, s: "x", nested: { a: [1, 2] } }]);
d.items.insertMany(Array.from({ length: 120 }, (_, i) => ({ _id: i + 1, name: "item " + (i + 1), price: i + 1 })));
d.items.createIndex({ name: 1 }, { unique: true });`,
    );

    for (const [c, bin] of [
      ["zz-explorer-redis", "redis-cli"],
      ["zz-explorer-redis8", "redis-cli"],
      ["zz-explorer-valkey", "valkey-cli"],
    ]) {
      seed(
        c,
        `REDISCLI_AUTH=${PASS} VALKEYCLI_AUTH=${PASS} ${bin} --no-auth-warning`,
        [
          "FLUSHALL",
          'SET "we\\x27ird key\\n$(id)" "v\\x00al"',
          'SET utf "caf\\xc3\\xa9 \\xf0\\x9f\\x98\\x80"',
          'SET big "18446744073709551615"',
          'HSET h f1 v1 f2 "\\xff\\xfe" "f 3" "line\\nbreak"',
          `RPUSH l ${Array.from({ length: 60 }, (_, i) => `v${i}`).join(" ")}`,
          "ZADD z 1.5 m1 2 m2 -3 m3",
          "SADD s x y z",
          "XADD st 1-1 k v n 1",
          "XADD st 2-1 k w",
          "EXPIRE h 3600",
          ...Array.from({ length: 150 }, (_, i) => `SET item:${i} ${i}`),
          "SELECT 3",
          "SET in3 yes",
        ].join("\n"),
      );
    }
  }, 300_000);

  afterAll(() => {
    if (process.env.SERVE_EXPLORER_KEEP) return;
    for (const name of Object.keys(CONTAINERS)) spawnSync("docker", ["rm", "-f", name]);
  });

  const sql = [
    { engine: "postgres", container: "zz-explorer-pg", c: creds("app", "app"), schema: "we'ird" },
    { engine: "postgres", container: "zz-explorer-pg16", c: creds("app", "app"), schema: "we'ird" },
    { engine: "mysql", container: "zz-explorer-mysql", c: creds("app", "app"), schema: null },
    { engine: "mariadb", container: "zz-explorer-mariadb", c: creds("app", "app"), schema: null },
    { engine: "clickhouse", container: "zz-explorer-ch", c: creds("default", "default"), schema: null },
  ] as const;

  for (const t of sql) {
    describe(`${t.engine} (${t.container})`, () => {
      const scripts = sqlScripts(t.engine, t.c);
      const table = { database: t.c.database, schema: t.schema, name: WEIRD_TABLE };
      const items = { database: t.c.database, schema: t.engine === "postgres" ? "public" : null, name: "items" };
      const marker = `SERVE_NULL_${crypto.randomBytes(4).toString("hex")}`;
      const rowsOf = (stdout: string, truncated: boolean) =>
        t.engine === "postgres" ? parsePgRows(stdout, marker, truncated) : t.engine === "clickhouse" ? parseChRows(stdout, truncated) : parseMyRows(stdout, truncated);
      const query = (text: string, readOnly = true) => {
        const r = run(t.container, scripts.query(t.c.database, text, { readOnly, timeoutSeconds: 10 }, marker));
        if (r.code !== 0) return { error: r.stderr };
        return t.engine === "postgres"
          ? parsePgQuery(r.stdout, marker, r.truncated)
          : t.engine === "clickhouse"
            ? parseChQuery(r.stdout, r.truncated)
            : parseMyQuery(r.stdout, marker, r.truncated);
      };

      it("lists databases and tables", () => {
        const o = parseSqlOverview(t.engine, ok(t.container, scripts.overview(t.c.database)).stdout, t.c.database);
        expect(o.databases.map((d) => d.name)).toContain(t.c.database);
        if (t.engine === "mysql" || t.engine === "mariadb") expect(o.databases.map((d) => d.name)).toContain("other db");
        expect(o.databases.map((d) => d.name)).not.toContain(t.engine === "clickhouse" ? "system" : "mysql");
        const weird = o.tables.find((x) => x.name === WEIRD_TABLE);
        expect(weird).toBeTruthy();
        expect(weird?.kind).toBe(t.engine === "clickhouse" ? "MergeTree" : "table");
        // InnoDB keeps an estimate.
        if (t.engine === "mysql" || t.engine === "mariadb") expect(o.tables.find((x) => x.name === "items")?.rows).toBeGreaterThan(100);
        else expect(o.tables.find((x) => x.name === "items")?.rows).toBe(120);
        if (t.engine === "postgres") expect(o.schemas).toEqual(expect.arrayContaining(["public", "we'ird"]));
      });

      it("describes columns and indexes", () => {
        const s = parseSqlStructure(t.engine, ok(t.container, scripts.structure(table)).stdout);
        expect(s?.columns.map((c) => c.name)).toEqual([
          "id",
          WEIRD_COL,
          ...(t.engine === "clickhouse" ? ["n", "big", "a"] : t.engine === "postgres" ? ["n", "j", "b", "big"] : ["b", "j", "n", "big"]),
        ]);
        expect(s?.columns[0].primaryKey).toBe(true);
        expect(s?.columns[1].primaryKey).toBe(false);
        if (t.engine === "postgres") expect(s?.columns.find((c) => c.name === "big")?.default).toBe("'9223372036854775807'::bigint");
        const idx = parseSqlStructure(t.engine, ok(t.container, scripts.structure(items)).stdout);
        expect(idx?.indexes.some((i) => i.primary)).toBe(true);
        expect(idx?.indexes.some((i) => /name/.test(i.definition) && !i.primary)).toBe(true);
        expect(parseSqlStructure(t.engine, ok(t.container, scripts.structure({ ...items, name: "nope'" })).stdout)).toBeNull();
      });

      it("pages, sorts and filters rows with awkward values", () => {
        const page = rowsOf(ok(t.container, scripts.rows(table, 0, { column: "id", desc: false }, null, marker)).stdout, false);
        expect(page.total).toBe(3);
        expect(page.columns[1]).toBe(WEIRD_COL);
        expect(page.rows[0][1]).toBe(WEIRD_VALUE);
        expect(page.rows[1][1]).toBe("");
        // NULL and the text 'NULL' stay apart.
        if (t.engine === "postgres") expect(page.rows[2][1]).toBeNull();
        else expect(page.rows[2][1]).toBe("NULL");
        if (t.engine === "postgres") expect(page.rows[0][5]).toBe("9223372036854775807");
        if (t.engine === "mysql" || t.engine === "mariadb") expect(page.rows[0][5]).toBe("18446744073709551615");
        if (t.engine === "clickhouse") expect(page.rows[0][3]).toBe("18446744073709551615");
        if (t.engine === "mysql" || t.engine === "mariadb") expect(page.rows[0][2]).toBe("0xDEAD00");

        const second = rowsOf(ok(t.container, scripts.rows(items, 2, { column: "price", desc: true }, null, marker)).stdout, false);
        expect(second.total).toBe(120);
        expect(second.rows.length).toBe(20);
        expect(second.rows[0][2]).toBe("20");
        const filtered = rowsOf(ok(t.container, scripts.rows(items, 0, null, { column: "price", op: "ge", value: "115" }, marker)).stdout, false);
        expect(filtered.total).toBe(6);
        const contains = rowsOf(ok(t.container, scripts.rows(items, 0, { column: "id", desc: false }, { column: "name", op: "contains", value: "ITEM 11" }, marker)).stdout, false);
        expect(contains.rows.map((r) => r[1])).toEqual([
          "item 11",
          "item 110",
          "item 111",
          "item 112",
          "item 113",
          "item 114",
          "item 115",
          "item 116",
          "item 117",
          "item 118",
          "item 119",
        ]);
        // A filter value is a literal, never SQL.
        for (const value of ["x' OR '1'='1", "x\\' OR 1=1 -- ", "x`); DROP TABLE items; --", "$(id)", "é😀\n"]) {
          const none = rowsOf(ok(t.container, scripts.rows(items, 0, null, { column: "name", op: "eq", value }, marker)).stdout, false);
          expect(none.total).toBe(0);
        }
        const weird = rowsOf(ok(t.container, scripts.rows(table, 0, null, { column: WEIRD_COL, op: "eq", value: WEIRD_VALUE }, marker)).stdout, false);
        expect(weird.total).toBe(1);
        const nulls = rowsOf(ok(t.container, scripts.rows(table, 0, null, { column: "n", op: "null" }, marker)).stdout, false);
        expect(nulls.total).toBe(t.engine === "clickhouse" ? 1 : t.engine === "postgres" ? 1 : 1);
        // An unknown column is the engine's error, not a broken script.
        expect(run(t.container, scripts.rows(items, 0, { column: 'nope" --', desc: false }, null, marker)).code).not.toBe(0);
      });

      it("runs queries and shows rows, counts and errors", () => {
        const r = query(t.engine === "clickhouse" ? "SELECT id, name FROM items ORDER BY id LIMIT 3" : "SELECT id, name FROM items ORDER BY id LIMIT 3");
        expect(r).toMatchObject({
          kind: "rows",
          columns: ["id", "name"],
          rows: [
            ["1", "item 1"],
            ["2", "item 2"],
            ["3", "item 3"],
          ],
        });
        const many = query(
          t.engine === "postgres"
            ? "SELECT g FROM generate_series(1, 5000) g"
            : t.engine === "clickhouse"
              ? "SELECT number FROM system.numbers LIMIT 5000"
              : "SELECT a.id FROM items a, items b",
        );
        expect(many).toMatchObject({ kind: "rows", truncated: true });
        if ("rows" in many) expect(many.rows.length).toBe(1000);
        const err = query("SELECT * FROM no_such_table");
        expect("error" in err && err.error).toMatch(/no_such_table/);
        const empty = query("SELECT id FROM items WHERE id < 0");
        expect(empty).toMatchObject({ kind: "rows", rows: [] });
      });

      it("blocks writes in read only mode", () => {
        const writes =
          t.engine === "clickhouse"
            ? [
                "INSERT INTO items VALUES (999, 'x', 1)",
                "ALTER TABLE items DELETE WHERE 1",
                "DROP TABLE items",
                "CREATE TABLE zz_x (a UInt8) ENGINE = Memory",
                "TRUNCATE TABLE items",
                "SET readonly = 0",
              ]
            : [
                "INSERT INTO items (name, price) VALUES ('x', 1)",
                "UPDATE items SET price = 0",
                "DELETE FROM items",
                "DROP TABLE items",
                "CREATE TABLE zz_x (a int)",
                "TRUNCATE items",
              ];
        for (const w of writes) {
          const r = query(w);
          expect("error" in r, `${w} must fail`).toBe(true);
        }
        // Tricks to leave the read-only transaction.
        if (t.engine !== "clickhouse") {
          for (const trick of ["COMMIT; DELETE FROM items", "SELECT 1; DELETE FROM items", "ROLLBACK; SET TRANSACTION READ WRITE; DELETE FROM items"])
            expect(() => query(trick)).toThrow(/one statement/);
          // One statement that ends the transaction cannot be followed by anything.
          const commit = query("COMMIT");
          expect(commit).not.toHaveProperty("rows");
        }
        if (t.engine === "postgres") {
          expect(query("SET default_transaction_read_only = off")).not.toHaveProperty("error");
          // Too late inside the statement: the transaction has its snapshot.
          expect(query("SELECT set_config('transaction_read_only', 'off', true), (SELECT count(*) FROM items)")).toHaveProperty("error");
          expect(() => query("\\! id")).toThrow(/psql commands/);
        }
        // Nothing changed.
        const count = query("SELECT count(*) AS c FROM items");
        expect(count).toMatchObject({ kind: "rows", rows: [["120"]] });
      });

      it("changes one value of a row, found by its primary key", () => {
        if (t.engine === "clickhouse") return;
        const engine = t.engine;
        const edit = (key: string, value: string | null) =>
          parseEditCount(
            ok(
              t.container,
              editCellScript(engine, t.c, { database: t.c.database, schema: t.schema, table: WEIRD_TABLE, key: [{ column: "id", value: key }], column: WEIRD_COL, value }),
            ).stdout,
          );
        expect(edit("2", `new ${WEIRD_VALUE}`)).toBe(1);
        const page = rowsOf(ok(t.container, scripts.rows(table, 0, { column: "id", desc: false }, null, marker)).stdout, false);
        expect(page.rows[1][1]).toBe(`new ${WEIRD_VALUE}`);
        expect(page.rows[0][1]).toBe(WEIRD_VALUE);
        expect(edit("2", null)).toBe(1);
        expect(rowsOf(ok(t.container, scripts.rows(table, 0, { column: "id", desc: false }, null, marker)).stdout, false).rows[1][1]).toBeNull();
        // The same value again still finds the row; a key that is not there finds none.
        expect(edit("2", null)).toBe(1);
        expect(edit("999", "x")).toBe(0);
        // A key is a value, never SQL: refused by the engine or matching nothing, and no other row changes.
        const injected = run(
          t.container,
          editCellScript(engine, t.c, {
            database: t.c.database,
            schema: t.schema,
            table: WEIRD_TABLE,
            key: [{ column: "id", value: "x' OR '1'='1" }],
            column: WEIRD_COL,
            value: "x",
          }),
        );
        expect(injected.code !== 0 || parseEditCount(injected.stdout) === 0).toBe(true);
        expect(rowsOf(ok(t.container, scripts.rows(table, 0, { column: "id", desc: false }, null, marker)).stdout, false).rows.map((r) => r[1])).not.toContain("x");
        expect(edit("2", "")).toBe(1);
        // Without a sort, the primary key keeps the changed row in its place.
        const kept = rowsOf(ok(t.container, scripts.rows({ ...table, order: ["id"] }, 0, null, null, marker)).stdout, false);
        expect(kept.rows.map((r) => r[0])).toEqual(["1", "2", "3"]);
      });

      it("writes when changes are allowed", () => {
        const done = query(t.engine === "clickhouse" ? "INSERT INTO items VALUES (500, 'zz written', 7)" : "INSERT INTO items (name, price) VALUES ('zz written', 7)", false);
        expect(done).toMatchObject({ kind: "done" });
        if (t.engine !== "clickhouse") expect(done).toMatchObject({ affected: 1 });
        if (t.engine !== "clickhouse") {
          const both = query("UPDATE items SET price = 8 WHERE name = 'zz written'; SELECT price FROM items WHERE name = 'zz written'", false);
          expect(both).toMatchObject({ kind: "rows", rows: [["8"]] });
          expect(query("DELETE FROM items WHERE name = 'zz written'", false)).toMatchObject({ kind: "done", affected: 1 });
        } else {
          expect(query("ALTER TABLE items DELETE WHERE id = 500 SETTINGS mutations_sync = 1", false)).toMatchObject({ kind: "done" });
        }
        expect(query("SELECT count(*) AS c FROM items")).toMatchObject({ kind: "rows", rows: [["120"]] });
      });
    });
  }

  describe("mongodb", () => {
    const c = creds("root", "app");
    const mongo = <T>(input: Parameters<typeof mongoScript>[1]) => parseMongo<T>(ok("zz-explorer-mongo", mongoScript(c, input)).stdout);

    it("lists databases and collections, and describes one", () => {
      const o = mongo<{ databases: { name: string }[]; tables: { name: string; rows: number }[] }>({ op: "overview", db: "app" });
      if ("error" in o && o.error) throw new Error(o.error);
      expect((o as { databases: { name: string }[] }).databases.map((d) => d.name)).toContain("app");
      const tables = (o as { tables: { name: string; rows: number }[] }).tables;
      expect(tables.find((x) => x.name === "we'ird.coll \"x")).toBeTruthy();
      expect(tables.find((x) => x.name === "items")?.rows).toBe(120);
      const s = mongo<{ found: boolean; indexes: { name: string; key: string; unique: boolean }[]; fields: Record<string, Record<string, number>> }>({
        op: "structure",
        db: "app",
        collection: "items",
      });
      expect(s).toMatchObject({ found: true });
      expect((s as { indexes: { name: string; unique: boolean }[] }).indexes.find((i) => i.name === "name_1")?.unique).toBe(true);
      expect(Object.keys((s as { fields: object }).fields)).toEqual(["_id", "name", "price"]);
      expect(mongo({ op: "structure", db: "app", collection: "nope" })).toMatchObject({ found: false });
    });

    it("pages documents with exact values", () => {
      const r = mongo<{ docs: string[]; total: number }>({ op: "documents", db: "app", collection: "we'ird.coll \"x", filter: '{"_id": 1}', skip: 0, limit: 50 }) as {
        docs: string[];
        total: number;
      };
      expect(r.total).toBe(1);
      const doc = JSON.parse(readableEjson(r.docs[0]));
      expect(doc.s).toBe(WEIRD_VALUE);
      expect(doc.big).toEqual({ $numberLong: "9223372036854775807" });
      expect(doc.dt).toEqual({ $date: "1970-01-01T00:00:00.000Z" });
      expect(doc.dec).toEqual({ $numberDecimal: "1.10" });
      const page = mongo<{ docs: string[]; total: number }>({ op: "documents", db: "app", collection: "items", sort: '{"price": -1}', skip: 50, limit: 50 }) as {
        docs: string[];
        total: number;
      };
      expect(page.total).toBe(120);
      expect(JSON.parse(readableEjson(page.docs[0])).price).toBe(70);
      expect(mongo({ op: "documents", db: "app", collection: "items", filter: "{bad json" })).toHaveProperty("error");
    });

    it("runs find, aggregate, count and distinct", () => {
      const find = mongo<{ docs: string[]; more: boolean }>({ op: "find", db: "app", collection: "items", query: '{"price": {"$gt": 100}}', limit: 1000 }) as {
        docs: string[];
        more: boolean;
      };
      expect(find.docs.length).toBe(20);
      expect(find.more).toBe(false);
      const capped = mongo<{ docs: string[]; more: boolean }>({ op: "find", db: "app", collection: "items", query: "{}", limit: 10 }) as { docs: string[]; more: boolean };
      expect(capped).toMatchObject({ more: true });
      expect(capped.docs.length).toBe(10);
      const agg = mongo<{ docs: string[] }>({ op: "aggregate", db: "app", collection: "items", query: '[{"$group": {"_id": null, "sum": {"$sum": "$price"}}}]' }) as {
        docs: string[];
      };
      expect(JSON.parse(readableEjson(agg.docs[0])).sum).toBe(7260);
      expect(mongo({ op: "count", db: "app", collection: "items", query: '{"price": {"$lte": 10}}' })).toMatchObject({ count: 10 });
      const distinct = mongo<{ docs: string[] }>({ op: "distinct", db: "app", collection: "items", field: "price", query: '{"price": {"$lte": 3}}' }) as { docs: string[] };
      expect(distinct.docs.map((d) => JSON.parse(readableEjson(d)).value)).toEqual([1, 2, 3]);
      expect(mongo({ op: "find", db: "app", collection: "items", query: '{"$where": "sleep(100)"}' })).toBeTruthy();
      expect(mongo({ op: "aggregate", db: "app", collection: "items", query: '{"$match": {}}' })).toHaveProperty("error");
    });

    it("refuses writes in read only mode", () => {
      expect(mongo({ op: "insert", db: "app", collection: "items", query: '{"a": 1}' })).toMatchObject({ error: expect.stringMatching(/read only/) });
      expect(mongo({ op: "update", db: "app", collection: "items", query: '{"filter": {}, "update": {"$set": {"price": 0}}}' })).toMatchObject({
        error: expect.stringMatching(/read only/),
      });
      expect(mongo({ op: "delete", db: "app", collection: "items", query: "{}" })).toMatchObject({ error: expect.stringMatching(/read only/) });
      for (const pipeline of ['[{"$out": "zz_out"}]', '[{"$match": {}}, {"$merge": {"into": "items"}}]', '[{"\\u0024out": "zz_out"}]'])
        expect(mongo({ op: "aggregate", db: "app", collection: "items", query: pipeline })).toMatchObject({ error: expect.stringMatching(/read only/) });
      expect(mongo({ op: "count", db: "app", collection: "items", query: "{}" })).toMatchObject({ count: 120 });
      expect(mongo({ op: "count", db: "app", collection: "zz_out", query: "{}" })).toMatchObject({ count: 0 });
    });

    it("replaces a document by its _id, keeping the _id", () => {
      const replace = (id: string, document: string) => mongo({ op: "replace", db: "app", collection: "items", id, query: document, readOnly: false });
      expect(mongo({ op: "replace", db: "app", collection: "items", id: "1", query: '{"x": 1}' })).toMatchObject({ error: expect.stringMatching(/read only/) });
      expect(replace("1", '{"_id": 1, "name": "renamed", "price": {"$numberLong": "9223372036854775807"}}')).toMatchObject({ affected: 1 });
      const doc = mongo<{ docs: string[] }>({ op: "find", db: "app", collection: "items", query: '{"_id": 1}' }) as { docs: string[] };
      expect(JSON.parse(readableEjson(doc.docs[0]))).toEqual({ _id: 1, name: "renamed", price: { $numberLong: "9223372036854775807" } });
      expect(replace("1", '{"_id": 2, "name": "x"}')).toMatchObject({ error: expect.stringMatching(/_id/) });
      expect(replace("1", "[1]")).toMatchObject({ error: expect.stringMatching(/object/) });
      expect(replace("4242", '{"name": "x"}')).toMatchObject({ affected: 0 });
      expect(replace("1", '{"name": "item 1", "price": 1}')).toMatchObject({ affected: 1 });
    });

    it("writes only through the write operations, with changes allowed", () => {
      const write = (input: Parameters<typeof mongoScript>[1]) => mongo({ ...input, readOnly: false });
      expect(write({ op: "insert", db: "app", collection: "zz_new", query: '[{"a": 1}, {"a": 2}]' })).toMatchObject({ affected: 2 });
      expect(write({ op: "update", db: "app", collection: "zz_new", query: '{"filter": {"a": 1}, "update": {"$set": {"b": true}}}' })).toMatchObject({ affected: 1 });
      expect(write({ op: "delete", db: "app", collection: "zz_new", query: "{}" })).toMatchObject({ affected: 2 });
      write({ op: "aggregate", db: "app", collection: "items", query: '[{"$match": {"price": 1}}, {"$out": "zz_out"}]' });
      expect(mongo({ op: "count", db: "app", collection: "zz_out", query: "{}" })).toMatchObject({ count: 1 });
      write({ op: "delete", db: "app", collection: "zz_out", query: "{}" });
    });
  });

  for (const [engine, container] of [
    ["redis", "zz-explorer-redis"],
    ["redis", "zz-explorer-redis8"],
    ["valkey", "zz-explorer-valkey"],
  ] as const) {
    describe(`${engine} (${container})`, () => {
      const c = creds("default", "0");
      const command = (line: string, database = 0) => parseKvReply(ok(container, kvCommandScript(engine, c, database, tokenizeCommand(line))).stdout);

      it("lists databases with keys", () => {
        expect(parseKeyspace(ok(container, kvKeyspaceScript(engine, c)).stdout)).toEqual([
          { name: "0", size: 158 },
          { name: "3", size: 1 },
        ]);
      });

      it("scans keys with a pattern, with types, TTLs and sizes", () => {
        const all: string[] = [];
        let cursor = "0";
        do {
          const page = parseKvScan(ok(container, kvScanScript(engine, c, 0, cursor, "*")).stdout);
          all.push(...page.keys.map((k) => k.key));
          cursor = page.cursor;
        } while (cursor !== "0");
        expect(new Set(all).size).toBe(158);
        expect(all).toContain("we'ird key\n$(id)");
        const some = parseKvScan(ok(container, kvScanScript(engine, c, 0, "0", "[hlz]")).stdout);
        expect(some.keys.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
          { key: "h", type: "hash", ttl: expect.any(Number), size: 3 },
          { key: "l", type: "list", ttl: -1, size: 60 },
          { key: "z", type: "zset", ttl: -1, size: 3 },
        ]);
        expect(some.keys.find((k) => k.key === "h")?.ttl).toBeGreaterThan(3_000_000);
        expect(parseKvScan(ok(container, kvScanScript(engine, c, 3, "0", "*")).stdout).keys.map((k) => k.key)).toEqual(["in3"]);
      });

      it("reads every kind of value, paged", () => {
        const key = (k: string, at = "0") => parseKvKey(ok(container, kvKeyScript(engine, c, 0, Buffer.from(k), at)).stdout, k);
        expect(key("we'ird key\n$(id)")).toMatchObject({ type: "string", entries: [['"v\\x00al"']] });
        expect(key("utf").entries).toEqual([["café 😀"]]);
        expect(key("big").entries).toEqual([["18446744073709551615"]]);
        expect(key("h").entries.sort()).toEqual([
          ["f 3", "line\nbreak"],
          ["f1", "v1"],
          ["f2", '"\\xff\\xfe"'],
        ]);
        const l1 = key("l");
        expect(l1.entries.length).toBe(50);
        expect(l1.entries[0]).toEqual(["0", "v0"]);
        expect(l1.next).toBe("50");
        const l2 = key("l", l1.next);
        expect(l2.entries.map((e) => e[1])).toEqual(Array.from({ length: 10 }, (_, i) => `v${50 + i}`));
        expect(key("z").entries).toEqual([
          ["m3", "-3"],
          ["m1", "1.5"],
          ["m2", "2"],
        ]);
        expect(
          key("s")
            .entries.map((e) => e[0])
            .sort(),
        ).toEqual(["x", "y", "z"]);
        expect(key("st").entries).toEqual([
          ["1-1", JSON.stringify({ k: "v", n: "1" })],
          ["2-1", JSON.stringify({ k: "w" })],
        ]);
        expect(key("missing")).toMatchObject({ type: "none", ttl: -2 });
      });

      it("runs commands and refuses writes in read only mode", () => {
        expect(command('GET "we\'ird key\\n$(id)"')).toEqual({ value: '"v\\x00al"' });
        expect(command("HGETALL h")).toMatchObject({ value: { f1: "v1" } });
        expect(command("INCRBY nope_counter")).toHaveProperty("error");
        expect(command("FOO bar")).toHaveProperty("error");
        expect(command("GET in3", 3)).toEqual({ value: "yes" });
        expect(command("EVAL_RO \"return redis.call('SET', KEYS[1], 1)\" 1 x")).toHaveProperty("error");
        // Writes go through when changes are allowed (the action checks the mode; see the unit tests).
        expect(command("SET zz_written 1")).toEqual({ value: "OK" });
        expect(command("DEL zz_written")).toEqual({ value: 1 });
      });
    });
  }
});
