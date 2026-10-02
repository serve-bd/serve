import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkKvCommand,
  chIdent,
  chLiteral,
  editCellScript,
  explorerFamily,
  framed,
  kvBytes,
  kvCommandScript,
  kvDecode,
  kvQuote,
  kvReadOnlyCommands,
  kvText,
  MAX_OUTPUT,
  mongoScript,
  myIdent,
  myLiteral,
  parseChQuery,
  parseClickhouseJson,
  parseCsv,
  parseEditCount,
  parseJsonExact,
  parseKeyspace,
  parseKvReply,
  parseMyQuery,
  parseMysqlXml,
  parseMyStructure,
  parsePgQuery,
  parsePgRows,
  pgConninfo,
  pgIdent,
  pgLiteral,
  pipelineWrites,
  readableEjson,
  splitStatements,
  sqlScripts,
  tokenizeCommand,
  unframe,
  unquoteKv,
} from "@/server/databases/explorer";

const creds = { username: "app", password: "pa'ss$word`x", database: "app" };
/** Every base64 payload a script decodes. */
const decoded = (lines: string[]) =>
  [...lines.join("\n").matchAll(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d|FROM_BASE64\('([A-Za-z0-9+/=]+)'\)|SERVE_INPUT='([A-Za-z0-9+/=]+)'/g)]
    .map((m) => Buffer.from(m[1] ?? m[2] ?? m[3], "base64").toString("utf8"))
    .join("\n");
/** Stand-ins for the database clients (they print their arguments) and for `id` (it leaves a mark). */
const stubs = fs.mkdtempSync(path.join(os.tmpdir(), "serve-explorer-"));
for (const name of ["psql", "mysql", "mariadb", "clickhouse-client", "mongosh", "redis-cli", "valkey-cli"])
  fs.writeFileSync(path.join(stubs, name), '#!/bin/sh\ncat >/dev/null\nfor a in "$@"; do printf "%s\\n" "$a"; done\n', { mode: 0o755 });
fs.writeFileSync(path.join(stubs, "id"), '#!/bin/sh\ntouch "$SERVE_STUB_DIR/ran-id"\n', { mode: 0o755 });
afterAll(() => fs.rmSync(stubs, { recursive: true, force: true }));
const AWKWARD = ["x'y", 'x"y', "x`y", "$(id)", "`id`", "${IFS}id", "a\nb", "é😀", "back\\slash", "semi;colon", "--", "/*", "x'); DROP TABLE t; --", "\\'", "''", "\u2028"];

describe("database explorer", () => {
  it("knows the family of each engine", () => {
    expect(["postgres", "mysql", "mariadb", "clickhouse"].map(explorerFamily)).toEqual(["sql", "sql", "sql", "sql"]);
    expect(explorerFamily("mongodb")).toBe("mongo");
    expect(explorerFamily("redis")).toBe("kv");
    expect(explorerFamily("valkey")).toBe("kv");
  });

  describe("quoting", () => {
    it("quotes PostgreSQL names and values", () => {
      expect(pgIdent('we"ird')).toBe('"we""ird"');
      expect(pgIdent("a'b`c$(x)\n")).toBe(`"a'b\`c$(x)\n"`);
      expect(pgLiteral("it's")).toBe("'it''s'");
      // A backslash makes an E'' literal, right with standard_conforming_strings on or off.
      expect(pgLiteral("a\\'b")).toBe("E'a\\\\''b'");
      expect(pgLiteral("é😀")).toBe("'é😀'");
      expect(() => pgIdent("a\0b")).toThrow(/NUL/);
      expect(() => pgLiteral("a\0b")).toThrow(/NUL/);
    });

    it("names a PostgreSQL database without connection options", () => {
      expect(pgConninfo("app")).toBe("dbname='app'");
      expect(pgConninfo("host=evil port=1")).toBe("dbname='host=evil port=1'");
      expect(pgConninfo("a'b\\c")).toBe("dbname='a\\'b\\\\c'");
    });

    it("quotes MySQL names, and values as hex", () => {
      expect(myIdent("we`ird")).toBe("`we``ird`");
      expect(myIdent("a'b\"c\\")).toBe("`a'b\"c\\`");
      expect(myLiteral("x' OR 1=1 -- ")).toBe(`_utf8mb4 X'${Buffer.from("x' OR 1=1 -- ").toString("hex")}'`);
      for (const v of AWKWARD) expect(myLiteral(v)).toMatch(/^_utf8mb4 X'[0-9a-f]*'$/);
    });

    it("quotes ClickHouse names and values", () => {
      expect(chIdent("we`ird\\")).toBe("`we\\`ird\\\\`");
      expect(chLiteral("it's \\ok")).toBe("'it\\'s \\\\ok'");
      expect(() => chLiteral("\0")).toThrow(/NUL/);
    });

    it("keeps every awkward name and value out of the shell", () => {
      for (const v of AWKWARD) {
        const scripts = [
          ...sqlScripts("postgres", creds).rows({ database: v, schema: v, name: v }, 0, { column: v, desc: true }, { column: v, op: "eq", value: v }, "N"),
          ...sqlScripts("mysql", creds).rows({ database: v, schema: null, name: v }, 0, { column: v, desc: false }, { column: v, op: "contains", value: v }, "N"),
          ...sqlScripts("clickhouse", creds).rows({ database: v, schema: null, name: v }, 0, null, { column: v, op: "ge", value: v }, "N"),
          ...sqlScripts("postgres", creds).query(v, `SELECT ${pgLiteral(v)}`, { readOnly: true, timeoutSeconds: 30 }, "N"),
          ...sqlScripts("mariadb", creds).query(v, `SELECT ${myLiteral(v)}`, { readOnly: true, timeoutSeconds: 30 }, "m"),
          ...mongoScript(creds, { op: "find", db: v, collection: v, query: JSON.stringify({ a: v }) }),
          ...kvCommandScript("redis", creds, 0, [Buffer.from("GET"), Buffer.from(v)]),
        ];
        // Run with stand-ins for the clients: a value that reached the shell would run `id`, which leaves a mark.
        const r = spawnSync("sh", ["-c", framed(scripts, "abc123", 30)], {
          encoding: "utf8",
          env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, SERVE_STUB_DIR: stubs },
        });
        expect(r.status, v).toBe(0);
        expect(unframe(r.stdout)?.code, v).toBe(0);
        expect(fs.existsSync(path.join(stubs, "ran-id")), v).toBe(false);
      }
      // The stand-ins got the database name as one argument, unchanged.
      const args = spawnSync("sh", ["-c", sqlScripts("mysql", creds).query("we'ird $(id) `id`", "SELECT 1", { readOnly: true, timeoutSeconds: 30 }, "m").join("\n")], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, SERVE_STUB_DIR: stubs },
      });
      expect(args.stdout.split("\n")).toContain("we'ird $(id) `id`");
    });

    it("puts names and values into the SQL quoted", () => {
      const pg = decoded(
        sqlScripts("postgres", creds).rows({ database: "app", schema: "s'x", name: 't"y' }, 2, { column: 'c"z', desc: true }, { column: "n", op: "contains", value: "o'k" }, "N"),
      );
      expect(pg).toContain(`FROM "s'x"."t""y" WHERE strpos(lower("n"::text), lower('o''k')) > 0 ORDER BY "c""z" DESC LIMIT 50 OFFSET 100`);
      expect(pg).toContain(`SELECT count(*) AS serve_total FROM (SELECT 1 FROM "s'x"."t""y" WHERE`);
      const ordered = decoded(sqlScripts("postgres", creds).rows({ database: "app", schema: "public", name: "t", order: ["a", 'b"c'] }, 0, null, null, "N"));
      expect(ordered).toContain(`FROM "public"."t" ORDER BY "a", "b""c" LIMIT 50 OFFSET 0`);
      // A chosen sort wins over the key order.
      expect(decoded(sqlScripts("mysql", creds).rows({ database: "d", schema: null, name: "t", order: ["id"] }, 0, { column: "x", desc: true }, null, "N"))).toContain(
        "ORDER BY `x` DESC LIMIT",
      );
      const my = decoded(sqlScripts("mysql", creds).rows({ database: "d`b", schema: null, name: "t" }, 0, null, { column: "c", op: "null" }, "N"));
      expect(my).toContain("FROM `d``b`.`t` WHERE `c` IS NULL LIMIT 50 OFFSET 0");
      const ch = decoded(
        sqlScripts("clickhouse", creds).rows({ database: "d", schema: null, name: "t`x" }, 1, { column: "a", desc: false }, { column: "b", op: "lt", value: "1'" }, "N"),
      );
      expect(ch).toContain("FROM `d`.`t\\`x` WHERE `b` < '1\\'' ORDER BY `a` ASC LIMIT 50 OFFSET 50");
    });
  });

  describe("read only", () => {
    const pg = sqlScripts("postgres", creds);
    const my = sqlScripts("mysql", creds);
    const ch = sqlScripts("clickhouse", creds);
    const opts = { readOnly: true, timeoutSeconds: 30 };

    it("runs PostgreSQL in a read-only transaction, read-only by default too", () => {
      const s = pg.query("app", "SELECT 1", opts, "N").join("\n");
      expect(s).toContain("-c 'BEGIN READ ONLY' -c \"$Q\"");
      expect(s).toContain("-c 'ROLLBACK'");
      expect(s).toContain("default_transaction_read_only=on");
      expect(s).toContain("statement_timeout=30000");
      expect(s).toContain("standard_conforming_strings=on");
      const w = pg.query("app", "SELECT 1", { ...opts, readOnly: false }, "N").join("\n");
      expect(w).not.toContain("READ ONLY");
      expect(w).not.toContain("default_transaction_read_only");
    });

    it("runs one statement at a time, so nothing can end the transaction and go on", () => {
      for (const q of ["COMMIT; DELETE FROM t", "select 1;delete from t", "ROLLBACK;\nUPDATE t SET a = 1", "SELECT 1; -- x\n; DROP TABLE t"]) {
        expect(() => pg.query("app", q, opts, "N")).toThrow(/one statement/);
        expect(() => my.query("app", q, opts, "m")).toThrow(/one statement/);
      }
      // Semicolons inside strings, names, comments and dollar quotes do not count.
      expect(() => pg.query("app", "SELECT ';', \"a;b\", $$x;y$$, $t$;$t$ -- ;\n/* ; /* ; */ */;", opts, "N")).not.toThrow();
      expect(() => my.query("app", "SELECT ';', \"a;b\", `c;d`, 'e\\';' # ;\n/* ; */ -- ;\n;", opts, "m")).not.toThrow();
      expect(() => pg.query("app", "  ", opts, "N")).toThrow(/Write a query/);
    });

    it("refuses COPY, which reaches files and programs even when read-only", () => {
      for (const q of ["COPY t TO '/tmp/x'", "copy (select 1) to program 'id'", "/* x */ -- y\n  COPY t FROM '/etc/passwd'"])
        expect(() => pg.query("app", q, opts, "N"), q).toThrow(/COPY/);
      expect(() => pg.query("app", "SELECT 'copy' AS copy", opts, "N")).not.toThrow();
      expect(() => pg.query("app", "COPY t TO STDOUT", { ...opts, readOnly: false }, "N")).not.toThrow();
    });

    it("refuses psql commands", () => {
      expect(() => pg.query("app", "\\! id", { ...opts, readOnly: false }, "N")).toThrow(/psql commands/);
      // Later lines are SQL for the server, not psql commands (psql -c does not read them).
      expect(() => pg.query("app", "SELECT 1\n\\! id", opts, "N")).not.toThrow();
    });

    it("sends MySQL statements as prepared statements from base64, read-only", () => {
      const s = my.query("app", "SELECT 'x'", opts, "serve_rc_1").join("\n");
      expect(s).toContain("SET SESSION TRANSACTION READ ONLY;");
      expect(s).toContain("START TRANSACTION READ ONLY;");
      // The whole text is one shell word (its quotes escaped): only our statements and base64 are in it.
      expect(s).toContain(`FROM_BASE64('\\''${Buffer.from("SELECT 'x'").toString("base64")}'\\'')`);
      expect(s).toContain("PREPARE serve_q FROM @serve_q;");
      expect(s).toContain("SET SESSION max_execution_time = 30000;");
      expect(s).not.toContain("SELECT 'x'");
      const maria = sqlScripts("mariadb", creds).query("app", "SELECT 1", opts, "m").join("\n");
      expect(maria).toContain("SET SESSION max_statement_time = 30;");
      // With changes allowed, each statement is prepared on its own.
      const many = my.query("app", "UPDATE t SET a = 1; SELECT 2", { ...opts, readOnly: false }, "m").join("\n");
      expect(many.match(/PREPARE serve_q FROM/g)?.length).toBe(2);
      expect(many).not.toContain("READ ONLY");
    });

    it("runs ClickHouse with readonly=2", () => {
      expect(ch.query("default", "SELECT 1", opts, "x").join("\n")).toContain("--readonly=2");
      expect(ch.query("default", "SELECT 1", { ...opts, readOnly: false }, "x").join("\n")).not.toContain("--readonly");
      expect(ch.query("default", "SELECT 1", opts, "x").join("\n")).toContain("--max_result_rows=1001 --result_overflow_mode=break");
    });

    it("allows only read commands on Redis and Valkey", () => {
      const check = (line: string, readOnly = true) => checkKvCommand(tokenizeCommand(line), readOnly);
      for (const ok of [
        "GET a",
        "get a",
        "HGETALL h",
        "SCAN 0 MATCH * COUNT 10",
        "TTL k",
        "XRANGE s - +",
        "OBJECT ENCODING k",
        "memory usage k",
        "EVAL_RO 'return 1' 0",
        "INFO",
        "ZRANGE z 0 -1 WITHSCORES",
      ])
        expect(check(ok), ok).toBeNull();
      for (const bad of [
        "SET a 1",
        "DEL a",
        "FLUSHALL",
        "FLUSHDB",
        "CONFIG GET *",
        "CONFIG SET save ''",
        "EVAL 'return 1' 0",
        "OBJECT FREQ2",
        "CLIENT KILL ID 1",
        "EXPIRE a 1",
        "RENAME a b",
        "SCRIPT FLUSH",
        "FUNCTION DELETE x",
      ])
        expect(check(bad), bad).toMatch(/not allowed in read only mode/);
      // Read only, but it stops a big database: SCAN instead.
      expect(check("KEYS *")).toMatch(/Use SCAN/);
      for (const never of ["MONITOR", "SUBSCRIBE c", "SHUTDOWN", "DEBUG SLEEP 1", "SELECT 2", "AUTH x"])
        expect(check(never, false), never).toMatch(/cannot run from here|Choose the database/);
      expect(check("SET a 1", false)).toBeNull();
      expect(check("3 PING", false)).toMatch(/command name/);
      expect(check("", false)).toMatch(/Write a command/);
      expect(kvReadOnlyCommands()).toContain("GET");
      expect(kvReadOnlyCommands()).not.toContain("SET");
    });

    it("finds $out and $merge anywhere in a pipeline", () => {
      expect(pipelineWrites([{ $match: {} }, { $out: "x" }])).toBe(true);
      expect(pipelineWrites([{ $facet: { a: [{ $merge: { into: "x" } }] } }])).toBe(true);
      expect(pipelineWrites([{ $lookup: { from: "y", pipeline: [{ $match: { $out: 1 } }] } }])).toBe(true);
      expect(pipelineWrites([{ $match: { out: "$out" } }, { $group: { _id: null } }])).toBe(false);
    });
  });

  describe("editing a row", () => {
    const edit = {
      database: "app",
      schema: "s'x",
      table: 't"y',
      key: [
        { column: "id", value: "1' OR '1'='1" },
        { column: "k`2", value: "b" },
      ],
      column: 'c"z',
      value: "it's",
    };
    it("finds the row by its whole primary key, with quoted names and values", () => {
      expect(decoded(editCellScript("postgres", creds, edit))).toBe(`UPDATE "s'x"."t""y" SET "c""z" = 'it''s' WHERE "id" = '1'' OR ''1''=''1' AND "k\`2" = 'b'`);
      expect(decoded(editCellScript("postgres", creds, { ...edit, value: null }))).toContain(`SET "c""z" = NULL WHERE`);
      const my = decoded(editCellScript("mysql", creds, edit));
      expect(my).toContain("START TRANSACTION;");
      expect(my).toContain(`UPDATE \`app\`.\`t"y\` SET \`c"z\` = ${myLiteral("it's")} WHERE \`id\` = ${myLiteral("1' OR '1'='1")} AND \`k\`\`2\` = ${myLiteral("b")} LIMIT 1;`);
      expect(my).toContain("SELECT CONCAT('SERVE_ROWS ', COUNT(*))");
      expect(() => editCellScript("postgres", creds, { ...edit, key: [] })).toThrow(/primary key/);
      expect(parseEditCount("SERVE_ROWS 1\n")).toBe(1);
      expect(parseEditCount("")).toBeNull();
    });
  });

  describe("splitting statements", () => {
    it("splits PostgreSQL at semicolons outside quotes", () => {
      expect(splitStatements("select 1; select 2;", "postgres")).toEqual(["select 1", "select 2"]);
      expect(splitStatements("select 'a;b'''; select E'c\\';d'; select 'e\\'; select 4", "postgres")).toEqual(["select 'a;b'''", "select E'c\\';d'", "select 'e\\'", "select 4"]);
      expect(splitStatements('select "a;""b"; select $fn$ ; $x$ ; $fn$; select $1; select a$b$c; select 2', "postgres")).toEqual([
        'select "a;""b"',
        "select $fn$ ; $x$ ; $fn$",
        "select $1",
        "select a$b$c",
        "select 2",
      ]);
      expect(splitStatements("select 1 /* a /* ; */ ; */; -- ;\n select 2", "postgres")).toEqual(["select 1 /* a /* ; */ ; */", "-- ;\n select 2"]);
      expect(splitStatements(" ;; -- only a comment\n ; ", "postgres")).toEqual([]);
      // An identifier ending in e is not an E'' string.
      expect(splitStatements("select name'\\'; select 2", "postgres")).toEqual(["select name'\\'", "select 2"]);
    });

    it("splits MySQL with its own quotes and comments", () => {
      expect(splitStatements("select 'a\\';b'; select \"c;d\"; select `e;f`; select 1 # ;\n; select 2 -- ;\n; select 3--4;", "mysql")).toEqual([
        "select 'a\\';b'",
        'select "c;d"',
        "select `e;f`",
        "select 1 # ;",
        "select 2 -- ;",
        "select 3--4",
      ]);
      expect(splitStatements("select 1 /* ; */", "mysql")).toEqual(["select 1 /* ; */"]);
    });
  });

  describe("parsing", () => {
    it("reads framed output, with stdout and stderr as base64", () => {
      const out = `${Buffer.from("a\tb\né😀").toString("base64")}\nSERVE_EXIT 3\n${Buffer.from("oops").toString("base64")}\n`;
      expect(unframe(out)).toEqual({ stdout: "a\tb\né😀", stderr: "oops", code: 3, truncated: false });
      expect(unframe("garbage")).toBeNull();
      const long = Buffer.alloc(MAX_OUTPUT + 1, 97).toString("base64");
      expect(unframe(`${long}\nSERVE_EXIT 0\n`)?.truncated).toBe(true);
      expect(framed(["echo hi"], "abc", 30)).toContain('T="timeout 35"');
      expect(() => framed(["x"], "a;b", 30)).toThrow();
    });

    it("runs a framed script in a real shell", () => {
      const r = spawnSync("sh", ["-c", framed(["printf 'x\\ny'; echo bad >&2; false"], "t1", 5)], { encoding: "utf8" });
      expect(unframe(r.stdout)).toEqual({ stdout: "x\ny", stderr: "bad\n", code: 1, truncated: false });
    });

    it("reads psql CSV with NULLs, quotes and newlines", () => {
      const csv = 'id,"na,me",x\n1,"line1\nline2 ""q""",N_X\n2,,""\n';
      expect(parseCsv(csv, "N_X")).toEqual({
        records: [
          ["id", "na,me", "x"],
          ["1", 'line1\nline2 "q"', null],
          ["2", "", ""],
        ],
        complete: true,
      });
      // A quoted field equal to the marker is text.
      expect(parseCsv('"N_X"\n', "N_X").records).toEqual([["N_X"]]);
      expect(parseCsv('a\n"cut', undefined)).toEqual({ records: [["a"]], complete: false });
    });

    it("reads a PostgreSQL query result", () => {
      expect(parsePgQuery("a,b\n1,N\nSERVE_ROWS 1\n", "N", false)).toEqual({ kind: "rows", columns: ["a", "b"], rows: [["1", null]], truncated: false, rowCount: 1 });
      expect(parsePgQuery("SERVE_ROWS 4\n", "N", false)).toEqual({ kind: "done", affected: 4, message: null });
      expect(parsePgQuery("a\nSERVE_ROWS 0\n", "N", false)).toMatchObject({ kind: "rows", columns: ["a"], rows: [] });
      // Cut at the size limit: the rows before, marked as cut.
      expect(parsePgQuery('a\n1\n2\n"3', "N", true)).toMatchObject({ kind: "rows", rows: [["1"], ["2"]], truncated: true });
      const many = `n\n${Array.from({ length: 1001 }, (_, i) => i).join("\n")}\nSERVE_ROWS 1001\n`;
      expect(parsePgQuery(many, "N", false)).toMatchObject({ truncated: true });
      // A value that looks like the marker line stays a value unless it is the last line.
      expect(parsePgQuery("a\nSERVE_ROWS 9\nSERVE_ROWS 1\n", "N", false)).toMatchObject({ rows: [["SERVE_ROWS 9"]], rowCount: 1 });
    });

    it("reads a page of PostgreSQL rows with its count", () => {
      expect(parsePgRows("serve_total\n10001\nid,v\n1,N\n", "N", false)).toEqual({ columns: ["id", "v"], rows: [["1", null]], total: 10000, totalCapped: true, truncated: false });
      const big = "x".repeat(30_000);
      expect(parsePgRows(`serve_total\n1\nv\n${big}\n`, "N", false).rows[0][0]).toHaveLength(20_001);
    });

    it("reads mysql --xml result sets", () => {
      const xml = `<?xml version="1.0"?>

<resultset statement="EXECUTE serve_q" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <row>
	<field name="a&quot;&lt;b">x &amp; &lt;y&gt;
z</field>
	<field name="n" xsi:nil="true" />
	<field name="e"></field>
  </row>
</resultset>
<?xml version="1.0"?>

<resultset statement="SELECT ROW_COUNT() AS serve_rc_1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <row>
	<field name="serve_rc_1">-1</field>
  </row>
</resultset>
`;
      expect(parseMysqlXml(xml)[0]).toEqual({ statement: "EXECUTE serve_q", columns: ['a"<b', "n", "e"], rows: [["x & <y>\nz", null, ""]] });
      expect(parseMyQuery(xml, "serve_rc_1", false)).toEqual({ kind: "rows", columns: ['a"<b', "n", "e"], rows: [["x & <y>\nz", null, ""]], truncated: false, rowCount: 1 });
      const dml = `<resultset statement="SELECT ROW_COUNT() AS serve_rc_1" xmlns:xsi="x">\n  <row>\n\t<field name="serve_rc_1">3</field>\n  </row>\n</resultset>\n`;
      expect(parseMyQuery(dml, "serve_rc_1", false)).toEqual({ kind: "done", affected: 3, message: null });
      // Rows of an earlier statement are not the result of a later one.
      expect(parseMyQuery(xml + dml, "serve_rc_1", false)).toMatchObject({ kind: "done", affected: 3 });
    });

    it("groups MySQL index parts", () => {
      const s = parseMyStructure({
        found: 1,
        columns: [
          { position: 2, name: "b", type: "int", nullable: 1, default: null, primaryKey: 0, extra: "" },
          { position: 1, name: "a", type: "bigint", nullable: 0, default: null, primaryKey: 1, extra: "auto_increment" },
        ],
        indexes: [
          { name: "k", unique: 0, seq: 2, column: "b", sub: null, type: "BTREE" },
          { name: "PRIMARY", unique: 1, seq: 1, column: "a", sub: null, type: "BTREE" },
          { name: "k", unique: 0, seq: 1, column: "a", sub: 10, type: "BTREE" },
        ],
      });
      expect(s?.columns.map((c) => [c.name, c.type, c.nullable, c.primaryKey])).toEqual([
        ["a", "bigint auto_increment", false, true],
        ["b", "int", true, false],
      ]);
      expect(s?.indexes).toEqual([
        { name: "PRIMARY", definition: "BTREE (a)", unique: true, primary: true },
        { name: "k", definition: "BTREE (a(10), b)", unique: false, primary: false },
      ]);
      expect(parseMyStructure({ found: 0, columns: null, indexes: null })).toBeNull();
    });

    it("reads ClickHouse JSONCompact, also when cut", () => {
      const one =
        '{\n\t"meta":\n\t[\n\t\t{\n\t\t\t"name": "a",\n\t\t\t"type": "UInt64"\n\t\t}\n\t],\n\n\t"data":\n\t[\n\t\t["18446744073709551615"],\n\t\t["2"]\n\t],\n\n\t"rows": 2\n}\n';
      expect(parseClickhouseJson(one)).toEqual([{ columns: ["a"], types: ["UInt64"], rows: [["18446744073709551615"], ["2"]], complete: true }]);
      const cut = one.slice(0, one.indexOf('["2"]') + 3);
      expect(parseClickhouseJson(cut)).toEqual([{ columns: ["a"], types: ["UInt64"], rows: [["18446744073709551615"]], complete: false }]);
      expect(parseChQuery(one + one, false)).toMatchObject({ kind: "rows", rows: [["18446744073709551615"], ["2"]] });
      expect(parseChQuery("┌─a─┐\n│ 1 │\n", false)).toEqual({ kind: "text", text: "┌─a─┐\n│ 1 │\n" });
      expect(parseChQuery("", false)).toEqual({ kind: "done", affected: null, message: null });
    });

    it("keeps big integers exact", () => {
      expect(parseJsonExact("[18446744073709551615, 1, 1.5, -9007199254740993]")).toEqual(["18446744073709551615", 1, 1.5, "-9007199254740993"]);
    });

    it("makes canonical Extended JSON readable without rounding", () => {
      const doc =
        '{"_id":{"$oid":"65a000000000000000000000"},"i":{"$numberInt":"5"},"d":{"$numberDouble":"1.5"},"big":{"$numberLong":"9223372036854775807"},"small":{"$numberLong":"7"},"t":{"$date":{"$numberLong":"0"}},"inf":{"$numberDouble":"Infinity"},"dec":{"$numberDecimal":"1.10"}}';
      expect(JSON.parse(readableEjson(doc))).toEqual({
        _id: { $oid: "65a000000000000000000000" },
        i: 5,
        d: 1.5,
        big: { $numberLong: "9223372036854775807" },
        small: 7,
        t: { $date: "1970-01-01T00:00:00.000Z" },
        inf: { $numberDouble: "Infinity" },
        dec: { $numberDecimal: "1.10" },
      });
    });

    it("passes MongoDB input as base64, never as code", () => {
      const s = mongoScript(creds, { op: "find", db: "d", collection: "c", query: '{"$where": "x"}`); process.exit(1); (`' });
      expect(s.join("\n")).not.toContain("process.exit(1)");
      expect(JSON.parse(decoded(s))).toMatchObject({ op: "find", db: "d", collection: "c", query: '{"$where": "x"}`); process.exit(1); (`' });
    });
  });

  describe("Redis and Valkey", () => {
    it("splits commands like redis-cli", () => {
      expect(tokenizeCommand(`SET "a b" 'c d' e\\x41 "\\x00\\n\\"" 'it\\'s'`).map((b) => b.toString("latin1"))).toEqual(["SET", "a b", "c d", "e\\x41", '\0\n"', "it's"]);
      expect(tokenizeCommand('GET "é"')[1].toString("utf8")).toBe("é");
      expect(() => tokenizeCommand('GET "a')).toThrow(/Unbalanced/);
      expect(() => tokenizeCommand('GET "a"b')).toThrow(/Unbalanced/);
      expect(tokenizeCommand("  ")).toEqual([]);
    });

    it("quotes arguments as plain ASCII, and reads them back", () => {
      for (const bytes of [...AWKWARD.map((v) => Buffer.from(v, "utf8")), Buffer.from([0xff, 0, 0x5c, 0x22, 0x27]), Buffer.from("plain")]) {
        const q = kvQuote(bytes);
        expect(q).toMatch(/^"[\x20-\x7e]*"$/);
        expect(q.slice(1, -1)).not.toMatch(/['"]/);
        expect(unquoteKv(q.slice(1, -1)).equals(bytes)).toBe(true);
      }
    });

    it("shows values as text when they are UTF-8, quoted otherwise, and round-trips keys", () => {
      expect(kvText("caf\\xc3\\xa9")).toBe("café");
      expect(kvText("v\\x00al")).toBe('"v\\x00al"');
      expect(kvText("\\xff\\xfe")).toBe('"\\xff\\xfe"');
      expect(kvText('\\"quoted\\"')).toBe('"\\x22quoted\\x22"');
      for (const raw of ["plain", "\xff\xfe", '"quoted"', "line\nbreak", "é"]) {
        const bytes = Buffer.from(raw, raw === "\xff\xfe" ? "latin1" : "utf8");
        expect(kvBytes(kvText(kvQuote(bytes).slice(1, -1))).equals(bytes), raw).toBe(true);
      }
      expect(kvDecode({ "f\\x01": ["a", 1, null] })).toEqual({ '"f\\x01"': ["a", 1, null] });
    });

    it("reads replies, errors and plain text", () => {
      expect(parseKvReply('"OK"\n')).toEqual({ value: "OK" });
      expect(parseKvReply("18446744073709551615\n")).toEqual({ value: "18446744073709551615" });
      expect(parseKvReply("error:\"ERR unknown command 'FOO'\"\n")).toEqual({ error: "ERR unknown command 'FOO'" });
      expect(parseKvReply("# Keyspace\ndb0:keys=3\n")).toEqual({ text: "# Keyspace\ndb0:keys=3" });
      expect(parseKeyspace("# Keyspace\r\ndb0:keys=3,expires=0\r\ndb4:keys=12,expires=1\r\n")).toEqual([
        { name: "0", size: 3 },
        { name: "4", size: 12 },
      ]);
      expect(parseKeyspace("# Keyspace\n")).toEqual([{ name: "0", size: 0 }]);
    });

    it("checks the database number and passes the password in the environment", () => {
      expect(() => kvCommandScript("redis", creds, 256, [Buffer.from("PING")])).toThrow();
      const s = kvCommandScript("valkey", { ...creds, tlsRequired: true }, 2, [Buffer.from("PING")]).join("\n");
      expect(s).toContain("valkey-cli --no-auth-warning --tls --insecure --quoted-input --quoted-json -n 2 '\"PING\"'");
      expect(s).toContain(`REDISCLI_AUTH='pa'\\''ss$word\`x'`);
    });
  });
});
