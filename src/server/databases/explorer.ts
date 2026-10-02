import crypto from "node:crypto";
import type { DbEngine } from "@/server/services/types";
import { type EngineCreds, pgDbname } from "./engines";

/*
 * The Data tab: scripts that read a database from inside its container (like the console does),
 * and parsers for what they print. Nothing a user writes reaches the shell: SQL, filters, names and
 * Redis arguments travel as base64 or as quoted strings, and table and column names are quoted per
 * engine wherever they appear in SQL.
 */

export type Family = "sql" | "mongo" | "kv";
export const explorerFamily = (engine: DbEngine | string): Family => (engine === "mongodb" ? "mongo" : engine === "redis" || engine === "valkey" ? "kv" : "sql");

/** Rows per page when browsing a table, collection or key. */
export const PAGE_SIZE = 50;
/** Rows a query returns at most. */
export const QUERY_LIMIT = 1000;
/** Seconds a query may run. */
export const QUERY_TIMEOUT = 30;
/** Longest query or command accepted (bytes): the script carries it on the exec command line. */
export const MAX_QUERY_BYTES = 64 * 1024;
/** Output kept from the database (bytes); the rest is cut in the container. */
export const MAX_OUTPUT = 4_000_000;
/** Characters kept of one value when browsing. */
export const MAX_CELL = 20_000;
/** Rows counted at most for a page's total (a full count of a huge table takes long). */
export const COUNT_CAP = 10_000;

export type FilterOp = "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "contains" | "null" | "notnull";
export const FILTER_OPS: FilterOp[] = ["eq", "ne", "lt", "le", "gt", "ge", "contains", "null", "notnull"];
export type RowFilter = { column: string; op: FilterOp; value?: string };
export type RowSort = { column: string; desc: boolean };

export type TableInfo = { schema: string | null; name: string; kind: string; rows: number | null; bytes: number | null };
export type ColumnInfo = { name: string; type: string; nullable: boolean; default: string | null; primaryKey: boolean };
export type IndexInfo = { name: string; definition: string; unique: boolean; primary: boolean };
export type Overview = { databases: { name: string; size: number | null }[]; database: string; schemas: string[]; tables: TableInfo[] };
export type Structure = { columns: ColumnInfo[]; indexes: IndexInfo[] };
export type Cell = string | null;
export type RowsPage = { columns: string[]; rows: Cell[][]; total: number | null; totalCapped: boolean; truncated: boolean };
export type QueryResult =
  | { kind: "rows"; columns: string[]; rows: Cell[][]; truncated: boolean; rowCount: number | null }
  | { kind: "documents"; documents: string[]; truncated: boolean }
  | { kind: "done"; affected: number | null; message: string | null }
  | { kind: "value"; value: string }
  | { kind: "text"; text: string };

/* ---------------------------------------------------------------- Quoting */

export const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
/** Text on a pipe, as base64. */
const pipe = (s: string) => `printf '%s' '${b64(s)}' | base64 -d`;
/** A shell variable holding the text (command substitution keeps it one word inside double quotes). */
const shVar = (name: string, s: string) => `${name}=$(${pipe(s)})`;

function noNul(s: string) {
  if (s.includes("\0")) throw new ExplorerInputError("Names and values cannot contain a NUL character.");
  return s;
}

export class ExplorerInputError extends Error {}

/** PostgreSQL identifier: "name", with " doubled. */
export const pgIdent = (s: string) => `"${noNul(s).replace(/"/g, '""')}"`;
/** PostgreSQL literal; with a backslash it is an E'' literal (as quote_literal does), right whatever standard_conforming_strings says. */
export const pgLiteral = (s: string) => {
  noNul(s);
  const body = s.replace(/'/g, "''");
  return s.includes("\\") ? `E'${body.replace(/\\/g, "\\\\")}'` : `'${body}'`;
};
/** A libpq connection string naming only the database: a name like "host=x" is not read as options. */
export const pgConninfo = (database: string) => pgDbname(noNul(database));
/** MySQL / MariaDB identifier: `name`, with ` doubled (the same in every SQL mode). */
export const myIdent = (s: string) => `\`${noNul(s).replace(/`/g, "``")}\``;
/** MySQL / MariaDB literal as hex with a character set: no escaping rules (NO_BACKSLASH_ESCAPES or not), and the column's collation wins. */
export const myLiteral = (s: string) => `_utf8mb4 X'${Buffer.from(noNul(s), "utf8").toString("hex")}'`;
/** ClickHouse identifier: `name`, with \ and ` escaped by a backslash. */
export const chIdent = (s: string) => `\`${noNul(s).replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;
/** ClickHouse literal: '...', with \ and ' escaped by a backslash. */
export const chLiteral = (s: string) => `'${noNul(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/* ---------------------------------------------------------- Running scripts */

/**
 * Wraps the commands so their output comes back intact: stdout and stderr as base64 (a split
 * multi-byte character or a stray marker cannot garble them), stdout cut at MAX_OUTPUT, then the
 * exit code. The client runs under `timeout` where the image has it, so a slow query cannot
 * outlive the request.
 */
export function framed(body: string[], nonce: string, timeoutSeconds: number) {
  if (!/^[a-z0-9]+$/.test(nonce)) throw new Error("Unexpected nonce");
  const f = `/tmp/serve-explore-${nonce}`;
  return [
    `T=; command -v timeout >/dev/null 2>&1 && T="timeout ${Math.ceil(timeoutSeconds) + 5}"`,
    "{",
    ...body,
    `echo $? >${f}.rc; } 2>${f}.err | head -c ${MAX_OUTPUT + 1} | base64`,
    `echo "SERVE_EXIT $(cat ${f}.rc 2>/dev/null)"`,
    `head -c 16384 ${f}.err 2>/dev/null | base64`,
    `rm -f ${f}.rc ${f}.err`,
  ].join("\n");
}

export type Framed = { stdout: string; stderr: string; code: number | null; truncated: boolean };

/** Reads what a framed script printed; null when the marker is missing (the script did not finish). */
export function unframe(output: string): Framed | null {
  const lines = output.split("\n");
  const at = lines.findIndex((l) => /^SERVE_EXIT( |$)/.test(l));
  if (at < 0) return null;
  const code = Number.parseInt(lines[at].slice("SERVE_EXIT".length).trim(), 10);
  const out = Buffer.from(lines.slice(0, at).join(""), "base64");
  const truncated = out.length > MAX_OUTPUT;
  return {
    stdout: (truncated ? out.subarray(0, MAX_OUTPUT) : out).toString("utf8"),
    stderr: Buffer.from(lines.slice(at + 1).join(""), "base64").toString("utf8"),
    code: Number.isFinite(code) ? code : null,
    truncated,
  };
}

/** An engine's error message without the noise its client adds. */
export function cleanError(engine: string, stderr: string) {
  let text = stderr.replace(/\r/g, "").trim();
  if (engine === "mysql" || engine === "mariadb") text = text.replace(/^ERROR (\d+) \(([0-9A-Z]+)\) at line \d+: /m, "ERROR $1 ($2): ");
  if (engine === "clickhouse") {
    text = text
      .replace(/^Received exception from server \(version [^)]*\):\n?/m, "")
      .replace(/\nStack trace[\s\S]*$/, "")
      .replace(/^\(query: [\s\S]*\)$/m, "")
      .replace(/DB::Exception: Received from [^.]*\. DB::Exception: /, "DB::Exception: ")
      .trim();
  }
  if (engine === "mongodb") text = text.replace(/^Uncaught:?\s*/m, "");
  const lines = text.split("\n").filter((l) => l.trim());
  return lines.slice(0, 12).join("\n").slice(0, 4000);
}

/* ------------------------------------------------------- Statement splitting */

export type Dialect = "postgres" | "mysql";
const identChar = (c: string | undefined) => !!c && /[A-Za-z0-9_$\u0080-\uffff]/.test(c);

/**
 * Splits SQL into statements at semicolons outside strings, quoted names, dollar quotes and
 * comments. PostgreSQL runs with standard_conforming_strings on, so only E'' strings take
 * backslash escapes; MySQL strings take them always (its PREPARE checks a statement is one).
 */
export function splitStatements(sql: string, dialect: Dialect): string[] {
  const out: string[] = [];
  let start = 0;
  let content = false;
  let i = 0;
  const n = sql.length;
  const push = (end: number) => {
    if (content) out.push(sql.slice(start, end).trim());
    start = end + 1;
    content = false;
  };
  const quoted = (close: string, backslash: boolean, doubled: boolean) => {
    i++;
    while (i < n) {
      const c = sql[i];
      if (backslash && c === "\\") i += 2;
      else if (c === close) {
        if (doubled && sql[i + 1] === close) i += 2;
        else {
          i++;
          return;
        }
      } else i++;
    }
  };
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-" && (dialect === "postgres" || i + 2 >= n || /[\s\x00-\x1f]/.test(sql[i + 2]))) {
      while (i < n && sql[i] !== "\n") i++;
    } else if (c === "#" && dialect === "mysql") {
      while (i < n && sql[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      // PostgreSQL comments nest; MySQL ones do not.
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else if (dialect === "postgres" && sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else i++;
      }
    } else if (c === "'") {
      content = true;
      const backslashes = dialect === "mysql" || (/[eE]/.test(sql[i - 1] ?? "") && !identChar(sql[i - 2]));
      quoted("'", backslashes, true);
    } else if (c === '"') {
      content = true;
      quoted('"', dialect === "mysql", true);
    } else if (c === "`" && dialect === "mysql") {
      content = true;
      quoted("`", false, true);
    } else if (c === "$" && dialect === "postgres" && !identChar(sql[i - 1])) {
      const tag = /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(sql.slice(i));
      content = true;
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end < 0 ? n : end + tag[0].length;
      } else i++;
    } else if (c === ";") {
      push(i);
      i++;
    } else {
      if (!/\s/.test(c)) content = true;
      i++;
    }
  }
  push(n);
  return out;
}

/** A statement without the comments and spaces before its first word. */
export function stripLeadingComments(statement: string) {
  let s = statement;
  for (;;) {
    const next = s
      .replace(/^\s+/, "")
      .replace(/^--[^\n]*(\n|$)/, "")
      .replace(/^\/\*[\s\S]*?\*\//, "");
    if (next === s) return s;
    s = next;
  }
}

/* ---------------------------------------------------------------- Parsers */

/** RFC 4180 CSV as psql prints it; `nullMarker` stands for NULL. Returns complete records only. */
export function parseCsv(text: string, nullMarker?: string): { records: Cell[][]; complete: boolean } {
  const records: Cell[][] = [];
  let record: Cell[] = [];
  let field = "";
  let quotedField = false;
  let i = 0;
  const n = text.length;
  const endField = () => {
    record.push(!quotedField && nullMarker !== undefined && field === nullMarker ? null : field);
    field = "";
    quotedField = false;
  };
  while (i < n) {
    const c = text[i];
    if (c === '"' && field === "" && !quotedField) {
      quotedField = true;
      i++;
      let closed = false;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            i++;
            closed = true;
            break;
          }
        } else field += text[i++];
      }
      if (!closed) return { records, complete: false };
    } else if (c === ",") {
      endField();
      i++;
    } else if (c === "\n" || (c === "\r" && text[i + 1] === "\n")) {
      endField();
      records.push(record);
      record = [];
      i += c === "\r" ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (field !== "" || quotedField || record.length) {
    // The last line had no newline: it may be cut.
    return { records, complete: false };
  }
  return { records, complete: true };
}

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const unxml = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10));
    return XML_ENTITIES[e] ?? m;
  });

export type XmlResultSet = { statement: string; columns: string[]; rows: Cell[][] };

/** The result sets of `mysql --xml` / `mariadb --xml`, row by row (a cut tail is dropped). */
export function parseMysqlXml(text: string): XmlResultSet[] {
  const sets: XmlResultSet[] = [];
  const setRe = /<resultset statement="([^"]*)"[^>]*>([\s\S]*?)(<\/resultset>|$)/g;
  for (const m of text.matchAll(setRe)) {
    const set: XmlResultSet = { statement: unxml(m[1]).trim(), columns: [], rows: [] };
    for (const row of m[2].matchAll(/<row>([\s\S]*?)<\/row>/g)) {
      const cells: Cell[] = [];
      const names: string[] = [];
      for (const f of row[1].matchAll(/<field name="([^"]*)"(?: xsi:nil="true" \/>|>([\s\S]*?)<\/field>)/g)) {
        names.push(unxml(f[1]));
        cells.push(f[2] === undefined ? null : unxml(f[2]));
      }
      if (!set.columns.length) set.columns = names;
      set.rows.push(cells);
    }
    sets.push(set);
  }
  return sets;
}

/** JSON.parse that keeps integers too big for a double as their digits. */
export function parseJsonExact(text: string): unknown {
  return JSON.parse(text, function (this: unknown, _key: string, value: unknown, context?: { source?: string }) {
    if (typeof value === "number" && context?.source && /^-?\d+$/.test(context.source) && !Number.isSafeInteger(value)) return context.source;
    return value;
  } as (this: unknown, key: string, value: unknown) => unknown);
}

export type ChResult = { columns: string[]; types: string[]; rows: unknown[][]; complete: boolean };

/**
 * ClickHouse JSONCompact output, one result per query (a script may hold several). Read line by
 * line: each row is on a line of its own, so output cut at the size limit still gives the rows before.
 */
export function parseClickhouseJson(text: string): ChResult[] | null {
  const results: ChResult[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (lines[i] !== "{") {
      if (lines[i].trim() === "") {
        i++;
        continue;
      }
      return null;
    }
    i++;
    const result: ChResult = { columns: [], types: [], rows: [], complete: false };
    while (i < lines.length && lines[i] !== "}") {
      const line = lines[i].trim();
      if (line === '"meta":') {
        const from = i + 1;
        while (i < lines.length && lines[i].trim() !== "],") i++;
        const meta = JSON.parse(`${lines.slice(from, i).join("\n")}]`) as { name: string; type: string }[];
        result.columns = meta.map((m) => m.name);
        result.types = meta.map((m) => m.type);
      } else if (line === '"data":') {
        i += 2;
        while (i < lines.length && lines[i].trim() !== "]," && lines[i].trim() !== "]") {
          const row = lines[i].trim().replace(/,$/, "");
          try {
            result.rows.push(parseJsonExact(row) as unknown[]);
          } catch {
            // A row cut at the size limit.
            break;
          }
          i++;
        }
      }
      i++;
    }
    result.complete = lines[i] === "}";
    i++;
    results.push(result);
  }
  return results;
}

/** A value as text for a table cell: strings as they are, everything else as JSON. */
export const asCell = (v: unknown): Cell => (v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v));
const capCell = (v: Cell): Cell => (v !== null && v.length > MAX_CELL ? `${v.slice(0, MAX_CELL)}…` : v);
/** A value the rows showed cut short (by capCell): only its start is known, so it cannot be written back. */
export const cappedCell = (v: Cell) => v !== null && v.length === MAX_CELL + 1 && v.endsWith("…");

/* -------------------------------------------------------------- PostgreSQL */

type Opts = { readOnly: boolean; timeoutSeconds: number };

function pgEnv(c: EngineCreds, opts: Opts) {
  const options = [`-c statement_timeout=${opts.timeoutSeconds * 1000}`, "-c standard_conforming_strings=on", ...(opts.readOnly ? ["-c default_transaction_read_only=on"] : [])];
  return [`export PGPASSWORD=${sh(c.password)}`, "export PGCLIENTENCODING=UTF8", `export PGOPTIONS=${sh(options.join(" "))}`];
}
const psql = (c: EngineCreds, database: string, flags: string) =>
  `$T psql -X -q -v ON_ERROR_STOP=1 -v SHOW_ALL_RESULTS=off ${flags} -U ${sh(c.username)} -d ${sh(pgConninfo(database))}`;
/** One SQL statement printing one JSON value, run read-only. */
function pgJson(c: EngineCreds, database: string, sql: string, timeoutSeconds = QUERY_TIMEOUT) {
  return [...pgEnv(c, { readOnly: true, timeoutSeconds }), shVar("S", sql), `${psql(c, database, "-At")} -c "$S"`];
}

const PG_SKIP_SCHEMAS = "n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'";
const PG_KINDS: Record<string, string> = { r: "table", p: "table", v: "view", m: "materialized view", f: "foreign table" };

function pgOverview(c: EngineCreds, database: string) {
  return pgJson(
    c,
    database,
    `SELECT json_build_object(
  'databases', (SELECT coalesce(json_agg(json_build_object('name', datname, 'size', pg_database_size(oid)) ORDER BY datname), '[]') FROM pg_database WHERE datallowconn AND NOT datistemplate AND has_database_privilege(oid, 'CONNECT')),
  'schemas', (SELECT coalesce(json_agg(n.nspname ORDER BY n.nspname), '[]') FROM pg_namespace n WHERE ${PG_SKIP_SCHEMAS}),
  'tables', (SELECT coalesce(json_agg(t ORDER BY t.schema, t.name), '[]') FROM (
    SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS rows, pg_total_relation_size(c.oid) AS bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition AND ${PG_SKIP_SCHEMAS}
    ORDER BY n.nspname, c.relname LIMIT 5000) t)
)`,
  );
}

function pgStructure(c: EngineCreds, database: string, schema: string, table: string) {
  const rel = `(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${pgLiteral(schema)} AND c.relname = ${pgLiteral(table)})`;
  return pgJson(
    c,
    database,
    `SELECT json_build_object(
  'found', EXISTS ${rel},
  'columns', (SELECT coalesce(json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'nullable', NOT a.attnotnull, 'default', pg_get_expr(d.adbin, d.adrelid), 'primaryKey', coalesce(a.attnum = ANY(pk.conkey), false)) ORDER BY a.attnum), '[]')
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    LEFT JOIN pg_constraint pk ON pk.conrelid = a.attrelid AND pk.contype = 'p'
    WHERE a.attrelid = ${rel} AND a.attnum > 0 AND NOT a.attisdropped),
  'indexes', (SELECT coalesce(json_agg(json_build_object('name', i.relname, 'definition', pg_get_indexdef(x.indexrelid), 'unique', x.indisunique, 'primary', x.indisprimary) ORDER BY x.indisprimary DESC, i.relname), '[]')
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = ${rel})
)`,
  );
}

function sqlCondition(engine: "postgres" | "mysql" | "clickhouse", filter: RowFilter | null | undefined) {
  if (!filter) return "";
  const col = engine === "postgres" ? pgIdent(filter.column) : engine === "clickhouse" ? chIdent(filter.column) : myIdent(filter.column);
  const lit = engine === "postgres" ? pgLiteral : engine === "clickhouse" ? chLiteral : myLiteral;
  const value = filter.value ?? "";
  const ops: Record<Exclude<FilterOp, "contains" | "null" | "notnull">, string> = { eq: "=", ne: "<>", lt: "<", le: "<=", gt: ">", ge: ">=" };
  switch (filter.op) {
    case "null":
      return ` WHERE ${col} IS NULL`;
    case "notnull":
      return ` WHERE ${col} IS NOT NULL`;
    case "contains":
      if (engine === "postgres") return ` WHERE strpos(lower(${col}::text), lower(${lit(value)})) > 0`;
      if (engine === "clickhouse") return ` WHERE positionCaseInsensitiveUTF8(toString(${col}), ${lit(value)}) > 0`;
      return ` WHERE LOCATE(LOWER(${lit(value)}), LOWER(CAST(${col} AS CHAR))) > 0`;
    default: {
      const op = ops[filter.op];
      if (!op) throw new ExplorerInputError("Unknown filter.");
      return ` WHERE ${col} ${op} ${lit(value)}`;
    }
  }
}

/** The ORDER BY of a page: the chosen column, else the given columns (the primary key: a stable order to page through). */
function orderBy(sort: RowSort | null, order: string[], ident: (s: string) => string) {
  if (sort) return ` ORDER BY ${ident(sort.column)} ${sort.desc ? "DESC" : "ASC"}`;
  return order.length ? ` ORDER BY ${order.map(ident).join(", ")}` : "";
}

function pgRows(
  c: EngineCreds,
  database: string,
  schema: string,
  table: string,
  page: number,
  sort: RowSort | null,
  order: string[],
  filter: RowFilter | null,
  nullMarker: string,
) {
  const from = `${pgIdent(schema)}.${pgIdent(table)}${sqlCondition("postgres", filter)}`;
  const sorted = orderBy(sort, order, pgIdent);
  return [
    ...pgEnv(c, { readOnly: true, timeoutSeconds: QUERY_TIMEOUT }),
    shVar("C", `SELECT count(*) AS serve_total FROM (SELECT 1 FROM ${from} LIMIT ${COUNT_CAP + 1}) serve_c`),
    shVar("R", `SELECT * FROM ${from}${sorted} LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}`),
    `${psql(c, database, `--csv -P ${sh(`null=${nullMarker}`)}`)} -c 'BEGIN READ ONLY' -c "$C" -c "$R" -c 'ROLLBACK'`,
  ];
}

/** Counted rows then the page, as two CSV results. */
export function parsePgRows(stdout: string, nullMarker: string, truncated: boolean): RowsPage {
  const nl = stdout.indexOf("\n", stdout.indexOf("\n") + 1);
  const total = Number.parseInt(stdout.slice(stdout.indexOf("\n") + 1, nl), 10);
  const { records, complete } = parseCsv(stdout.slice(nl + 1), nullMarker);
  const [columns = [], ...rows] = records;
  return { columns: columns.map((c) => c ?? ""), rows: rows.map((r) => r.map(capCell)), ...counted(total), truncated: truncated || !complete };
}

const counted = (total: number) => (Number.isFinite(total) ? { total: Math.min(total, COUNT_CAP), totalCapped: total > COUNT_CAP } : { total: null, totalCapped: false });

function pgQuery(c: EngineCreds, database: string, sql: string, opts: Opts & { nullMarker: string }) {
  const statements = splitStatements(sql, "postgres");
  if (!statements.length) throw new ExplorerInputError("Write a query first.");
  if (opts.readOnly && statements.length > 1) throw new ExplorerInputError("Read only mode runs one statement at a time. Run them one by one, or allow changes.");
  // COPY reads or writes files and runs programs on the server, even in a read-only transaction.
  if (opts.readOnly && /^copy\b/i.test(stripLeadingComments(statements[0]))) throw new ExplorerInputError("COPY is not available in read only mode. Use SELECT to read rows.");
  const text = sql.trim();
  // A -c string that starts with a backslash would be a psql command, not SQL.
  if (text.startsWith("\\")) throw new ExplorerInputError("psql commands (like \\d) are not available here. Write SQL instead.");
  // FETCH_COUNT streams a big result instead of holding it all; psql allows it for one statement only.
  const flags = `--csv -P ${sh(`null=${opts.nullMarker}`)}${statements.length === 1 ? ` -v FETCH_COUNT=${QUERY_LIMIT + 1}` : ""}`;
  return [
    ...pgEnv(c, opts),
    shVar("Q", text),
    `${psql(c, database, flags)}${opts.readOnly ? " -c 'BEGIN READ ONLY'" : ""} -c "$Q" -c '\\echo SERVE_ROWS :ROW_COUNT'${opts.readOnly ? " -c 'ROLLBACK'" : ""}`,
  ];
}

export function parsePgQuery(stdout: string, nullMarker: string, truncated: boolean, limit = QUERY_LIMIT): QueryResult {
  const m = /(?:^|\n)SERVE_ROWS (\d+)\n?$/.exec(stdout);
  const csv = m ? stdout.slice(0, m.index + (m[0].startsWith("\n") ? 1 : 0)) : stdout;
  const rowCount = m ? Number(m[1]) : null;
  if (!csv.trim() && m) return { kind: "done", affected: rowCount, message: null };
  const { records, complete } = parseCsv(csv, nullMarker);
  const [columns = [], ...rows] = records;
  return {
    kind: "rows",
    columns: columns.map((c) => c ?? ""),
    rows: rows.slice(0, limit),
    truncated: rows.length > limit || truncated || !complete || !m,
    rowCount,
  };
}

/* ---------------------------------------------------------- MySQL / MariaDB */

const MY_SYSTEM = ["information_schema", "mysql", "performance_schema", "sys"];

function myCli(engine: "mysql" | "mariadb", c: EngineCreds, flags: string, database?: string) {
  return {
    env: [
      `export MYSQL_PWD=${sh(c.password)}`,
      // Values of binary columns as 0x… hex rather than raw bytes (older clients do not have the option).
      `BH=; ${engine} --help 2>/dev/null | grep -q -- --binary-as-hex && BH=--binary-as-hex`,
    ],
    cmd: `$T ${engine} -uroot --default-character-set=utf8mb4 ${flags}${database ? ` -D ${sh(database)}` : ""}`,
  };
}
const myTimeout = (engine: "mysql" | "mariadb", seconds: number) =>
  engine === "mysql" ? `SET SESSION max_execution_time = ${seconds * 1000};` : `SET SESSION max_statement_time = ${seconds};`;

function myJson(engine: "mysql" | "mariadb", c: EngineCreds, sql: string) {
  const cli = myCli(engine, c, "-N -B -r");
  return [
    ...cli.env,
    // MariaDB builds JSON_ARRAYAGG on GROUP_CONCAT, which stops at this length.
    `${pipe(`SET SESSION group_concat_max_len = 67108864;\n${myTimeout(engine, QUERY_TIMEOUT)}\n${sql}`)} | ${cli.cmd}`,
  ];
}

function myOverview(engine: "mysql" | "mariadb", c: EngineCreds, database: string) {
  const skip = MY_SYSTEM.map((d) => `'${d}'`).join(", ");
  return myJson(
    engine,
    c,
    `SELECT JSON_OBJECT(
  'databases', (SELECT JSON_ARRAYAGG(JSON_OBJECT('name', s.schema_name, 'size', (SELECT SUM(t.data_length + t.index_length) FROM information_schema.tables t WHERE t.table_schema = s.schema_name))) FROM information_schema.schemata s WHERE s.schema_name NOT IN (${skip})),
  'tables', (SELECT JSON_ARRAYAGG(JSON_OBJECT('name', table_name, 'kind', table_type, 'rows', table_rows, 'bytes', data_length + index_length)) FROM information_schema.tables WHERE table_schema = ${myLiteral(database)})
);`,
  );
}

function myStructure(engine: "mysql" | "mariadb", c: EngineCreds, database: string, table: string) {
  const where = `table_schema = ${myLiteral(database)} AND table_name = ${myLiteral(table)}`;
  return myJson(
    engine,
    c,
    `SELECT JSON_OBJECT(
  'found', (SELECT COUNT(*) FROM information_schema.tables WHERE ${where}),
  'columns', (SELECT JSON_ARRAYAGG(JSON_OBJECT('position', ordinal_position, 'name', column_name, 'type', column_type, 'nullable', is_nullable = 'YES', 'default', column_default, 'primaryKey', column_key = 'PRI', 'extra', extra)) FROM information_schema.columns WHERE ${where}),
  'indexes', (SELECT JSON_ARRAYAGG(JSON_OBJECT('name', index_name, 'unique', non_unique = 0, 'seq', seq_in_index, 'column', column_name, 'sub', sub_part, 'type', index_type)) FROM information_schema.statistics WHERE ${where})
);`,
  );
}

type MyColumn = { position: number; name: string; type: string; nullable: boolean | number; default: string | null; primaryKey: boolean | number; extra: string | null };
type MyIndexPart = { name: string; unique: boolean | number; seq: number; column: string | null; sub: number | null; type: string };

export function parseMyStructure(json: { found: number; columns: MyColumn[] | null; indexes: MyIndexPart[] | null }): Structure | null {
  if (!json.found) return null;
  const columns = [...(json.columns ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((col) => ({
      name: col.name,
      type: col.extra ? `${col.type} ${col.extra}` : col.type,
      nullable: !!col.nullable,
      default: col.default,
      primaryKey: !!col.primaryKey,
    }));
  const byName = new Map<string, MyIndexPart[]>();
  for (const part of json.indexes ?? []) byName.set(part.name, [...(byName.get(part.name) ?? []), part]);
  const indexes = [...byName.entries()].map(([name, parts]) => {
    const cols = parts.sort((a, b) => a.seq - b.seq).map((p) => `${p.column ?? "(expression)"}${p.sub ? `(${p.sub})` : ""}`);
    return { name, definition: `${parts[0].type} (${cols.join(", ")})`, unique: !!parts[0].unique, primary: name === "PRIMARY" };
  });
  indexes.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
  return { columns, indexes };
}

function myRows(engine: "mysql" | "mariadb", c: EngineCreds, database: string, table: string, page: number, sort: RowSort | null, order: string[], filter: RowFilter | null) {
  const from = `${myIdent(database)}.${myIdent(table)}${sqlCondition("mysql", filter)}`;
  const sorted = orderBy(sort, order, myIdent);
  const cli = myCli(engine, c, "--xml --quick $BH");
  return [
    ...cli.env,
    `${pipe(
      [
        myTimeout(engine, QUERY_TIMEOUT),
        "START TRANSACTION READ ONLY;",
        `SELECT COUNT(*) AS serve_total FROM (SELECT 1 FROM ${from} LIMIT ${COUNT_CAP + 1}) AS serve_c;`,
        `SELECT * FROM ${from}${sorted} LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE};`,
        "ROLLBACK;",
      ].join("\n"),
    )} | ${cli.cmd}`,
  ];
}

export function parseMyRows(stdout: string, truncated: boolean): RowsPage {
  const [count, rows] = parseMysqlXml(stdout);
  const total = Number.parseInt(count?.rows[0]?.[0] ?? "", 10);
  return { columns: rows?.columns ?? [], rows: (rows?.rows ?? []).map((r) => r.map(capCell)), ...counted(total), truncated: truncated || !rows };
}

/**
 * Each statement goes to the server as a prepared statement, from base64: the client never parses
 * it (no client commands), and the server takes exactly one statement per PREPARE.
 */
function myQuery(engine: "mysql" | "mariadb", c: EngineCreds, database: string, sql: string, opts: Opts, marker: string) {
  const statements = splitStatements(sql, "mysql");
  if (!statements.length) throw new ExplorerInputError("Write a query first.");
  if (opts.readOnly && statements.length > 1) throw new ExplorerInputError("Read only mode runs one statement at a time. Run them one by one, or allow changes.");
  const lines = [
    myTimeout(engine, opts.timeoutSeconds),
    `SET SESSION sql_select_limit = ${QUERY_LIMIT + 1};`,
    // The session default too: a procedure that commits starts its next transaction read-only as well.
    ...(opts.readOnly ? ["SET SESSION TRANSACTION READ ONLY;", "START TRANSACTION READ ONLY;"] : []),
  ];
  for (const s of statements) {
    lines.push(
      `SET @serve_q = CONVERT(FROM_BASE64('${b64(s)}') USING utf8mb4);`,
      "PREPARE serve_q FROM @serve_q;",
      "EXECUTE serve_q;",
      `SELECT ROW_COUNT() AS ${marker};`,
      "DEALLOCATE PREPARE serve_q;",
    );
  }
  if (opts.readOnly) lines.push("ROLLBACK;");
  // Only our own statements and base64 are in this text: it is safe on the command line as it is.
  const cli = myCli(engine, c, "--xml --quick $BH", database);
  return [...cli.env, `printf '%s\\n' ${sh(lines.join("\n"))} | ${cli.cmd}`];
}

export function parseMyQuery(stdout: string, marker: string, truncated: boolean, limit = QUERY_LIMIT): QueryResult {
  const sets = parseMysqlXml(stdout);
  // The result of the last statement: its rows (if any) come right before its ROW_COUNT marker.
  let last: XmlResultSet | null = null;
  let affected: number | null = null;
  let previous: XmlResultSet | null = null;
  for (const set of sets) {
    if (set.statement.includes(marker)) {
      last = previous;
      affected = Number.parseInt(set.rows[0]?.[0] ?? "", 10);
      previous = null;
    } else previous = set;
  }
  if (previous) last = previous;
  if (!last) return { kind: "done", affected: Number.isFinite(affected) && affected !== null && affected >= 0 ? affected : null, message: null };
  return {
    kind: "rows",
    columns: last.columns,
    rows: last.rows.slice(0, limit),
    truncated: truncated || last.rows.length > limit,
    rowCount: last.rows.length > limit ? null : last.rows.length,
  };
}

/* --------------------------------------------------------------- ClickHouse */

const CH_SYSTEM = ["system", "INFORMATION_SCHEMA", "information_schema"];

function chCli(c: EngineCreds, database: string, opts: Opts & { limit?: number }) {
  const settings = [
    "--format=JSONCompact",
    "--output_format_json_quote_64bit_integers=1",
    "--output_format_json_quote_decimals=1",
    "--output_format_json_quote_64bit_floats=1",
    `--max_execution_time=${opts.timeoutSeconds}`,
    ...(opts.limit ? [`--max_result_rows=${opts.limit + 1}`, "--result_overflow_mode=break"] : []),
    // 2: reads only, settings may still change (but not this one).
    ...(opts.readOnly ? ["--readonly=2"] : []),
  ];
  return `$T clickhouse-client -u ${sh(c.username)} --password ${sh(c.password)} -d ${sh(database)} ${settings.join(" ")}`;
}
const chRun = (c: EngineCreds, database: string, sql: string, opts: Opts & { limit?: number }) => [`${pipe(sql)} | ${chCli(c, database, opts)}`];

function chOverview(c: EngineCreds, database: string) {
  const skip = CH_SYSTEM.map(chLiteral).join(", ");
  return chRun(
    c,
    database,
    `SELECT d.name, toString(p.b) FROM system.databases AS d LEFT JOIN (SELECT database, sum(bytes_on_disk) AS b FROM system.parts WHERE active GROUP BY database) AS p ON p.database = d.name WHERE d.name NOT IN (${skip}) ORDER BY d.name;
SELECT name, engine, toString(total_rows), toString(total_bytes) FROM system.tables WHERE database = ${chLiteral(database)} AND NOT is_temporary AND name NOT LIKE '.inner%' ORDER BY name LIMIT 5000;`,
    { readOnly: true, timeoutSeconds: QUERY_TIMEOUT },
  );
}

function chStructure(c: EngineCreds, database: string, table: string) {
  const where = `database = ${chLiteral(database)} AND table = ${chLiteral(table)}`;
  return chRun(
    c,
    database,
    `SELECT name, type, default_kind, default_expression, is_in_primary_key, is_in_sorting_key FROM system.columns WHERE ${where} ORDER BY position;
SELECT engine, primary_key, sorting_key, partition_key FROM system.tables WHERE database = ${chLiteral(database)} AND name = ${chLiteral(table)};
SELECT name, type, expr, granularity FROM system.data_skipping_indices WHERE ${where} ORDER BY name;`,
    { readOnly: true, timeoutSeconds: QUERY_TIMEOUT },
  );
}

export function parseChStructure(results: ChResult[]): Structure | null {
  const [cols, tables, skipping] = results;
  if (!tables?.rows.length) return null;
  const columns = (cols?.rows ?? []).map((r) => {
    const [name, type, kind, expr, inPrimary] = r as [string, string, string, string, number | string];
    return { name, type, nullable: /^Nullable\(/.test(type), default: kind ? `${kind} ${expr}` : null, primaryKey: Number(inPrimary) === 1 };
  });
  const [engine, primaryKey, sortingKey, partitionKey] = tables.rows[0] as string[];
  const indexes: IndexInfo[] = [];
  if (primaryKey) indexes.push({ name: "Primary key", definition: primaryKey, unique: false, primary: true });
  if (sortingKey && sortingKey !== primaryKey) indexes.push({ name: "Sorting key", definition: sortingKey, unique: false, primary: false });
  if (partitionKey) indexes.push({ name: "Partition key", definition: partitionKey, unique: false, primary: false });
  for (const r of skipping?.rows ?? []) {
    const [name, type, expr, granularity] = r as string[];
    indexes.push({ name, definition: `${type} (${expr}) granularity ${granularity}`, unique: false, primary: false });
  }
  if (!indexes.length && engine) indexes.push({ name: "Engine", definition: engine, unique: false, primary: false });
  return { columns, indexes };
}

function chRows(c: EngineCreds, database: string, table: string, page: number, sort: RowSort | null, order: string[], filter: RowFilter | null) {
  const from = `${chIdent(database)}.${chIdent(table)}${sqlCondition("clickhouse", filter)}`;
  const sorted = orderBy(sort, order, chIdent);
  return chRun(
    c,
    database,
    `SELECT toString(count()) FROM (SELECT 1 FROM ${from} LIMIT ${COUNT_CAP + 1});\nSELECT * FROM ${from}${sorted} LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE};`,
    {
      readOnly: true,
      timeoutSeconds: QUERY_TIMEOUT,
    },
  );
}

export function parseChRows(stdout: string, truncated: boolean): RowsPage {
  const results = parseClickhouseJson(stdout) ?? [];
  const total = Number.parseInt(String(results[0]?.rows[0]?.[0] ?? ""), 10);
  const page = results[1];
  return {
    columns: page?.columns ?? [],
    rows: (page?.rows ?? []).map((r) => r.map((v) => capCell(asCell(v)))),
    ...counted(total),
    truncated: truncated || !page?.complete,
  };
}

export function parseChQuery(stdout: string, truncated: boolean, limit = QUERY_LIMIT): QueryResult {
  if (!stdout.trim()) return { kind: "done", affected: null, message: null };
  const results = parseClickhouseJson(stdout);
  // A query with its own FORMAT clause prints that format: shown as text.
  if (!results?.length) return { kind: "text", text: stdout };
  const last = results[results.length - 1];
  return {
    kind: "rows",
    columns: last.columns,
    rows: last.rows.slice(0, limit).map((r) => r.map(asCell)),
    truncated: truncated || !last.complete || last.rows.length > limit,
    rowCount: last.complete && last.rows.length <= limit ? last.rows.length : null,
  };
}

/* ------------------------------------------------------------------ MongoDB */

export type MongoOp = "find" | "aggregate" | "count" | "distinct" | "insert" | "update" | "delete";
export const MONGO_READ_OPS: MongoOp[] = ["find", "aggregate", "count", "distinct"];
export const MONGO_WRITE_OPS: MongoOp[] = ["insert", "update", "delete"];

/** Whether a pipeline writes ($out or $merge anywhere in it). */
export function pipelineWrites(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(pipelineWrites);
  if (value && typeof value === "object") return Object.entries(value).some(([k, v]) => k === "$out" || k === "$merge" || pipelineWrites(v));
  return false;
}

/**
 * The mongosh script: fixed code, with the request as base64 JSON. User filters and pipelines are
 * Extended JSON parsed by EJSON, never evaluated. Documents come back as canonical Extended JSON
 * (exact types and numbers) and are made readable by readableEjson.
 */
const MONGO_SCRIPT = `
const input = JSON.parse(Buffer.from(process.env.SERVE_INPUT, "base64").toString("utf8"));
const ej = (s, fallback) => (s === undefined || s === null || String(s).trim() === "" ? fallback : EJSON.parse(String(s), { relaxed: false }));
const out = (d) => { const s = EJSON.stringify(d, { relaxed: false }); return s.length > 200000 ? EJSON.stringify({ _id: d && d._id, "(too large to show)": s.length + " characters" }, { relaxed: false }) : s; };
// A fingerprint of a document as stored (canonical Extended JSON, so types count): an edit is saved
// only over the document it was made from. A hash keeps the request small; it guards against
// mistakes, not against someone who can edit the collection anyway.
const version = (d) => {
  const s = EJSON.stringify(d, { relaxed: false });
  let h1 = 0xdeadbeef ^ s.length, h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return s.length.toString(16) + "-" + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
};
const take = (cursor, n) => { const docs = []; while (docs.length < n && cursor.hasNext()) docs.push(out(cursor.next())); return { docs, more: cursor.hasNext() }; };
const ms = input.timeoutMs;
const writes = (v) => Array.isArray(v) ? v.some(writes) : !!v && typeof v === "object" && Object.entries(v).some(([k, x]) => k === "$out" || k === "$merge" || writes(x));
let result;
try {
  // Checked by the server action too: read only runs reads, and pipelines without $out or $merge.
  if (input.readOnly && !["overview", "structure", "documents", "find", "aggregate", "count", "distinct"].includes(input.op)) throw new Error(input.op + " changes data, so it is not allowed in read only mode.");
  const d = db.getSiblingDB(input.db);
  const coll = () => d.getCollection(input.collection);
  switch (input.op) {
    case "overview": {
      const dbs = db.adminCommand({ listDatabases: 1 }).databases.map((x) => ({ name: x.name, size: Number(x.sizeOnDisk) }));
      const colls = d.getCollectionInfos({}, { nameOnly: false }).filter((c) => !c.name.startsWith("system.")).slice(0, 2000);
      const tables = colls.map((c, i) => {
        const kind = c.type === "view" ? "view" : c.type === "timeseries" ? "time series" : "collection";
        let rows = null, bytes = null;
        // Sizes of the first 300 only: each is a round trip.
        if (kind !== "view" && i < 300) try { const s = d.getCollection(c.name).aggregate([{ $collStats: { storageStats: {} } }]).toArray()[0].storageStats; rows = Number(s.count); bytes = Number(s.totalSize); } catch (e) {}
        return { name: c.name, kind, rows, bytes };
      });
      result = { databases: dbs, tables };
      break;
    }
    case "structure": {
      const exists = d.getCollectionInfos({ name: input.collection }).length > 0;
      if (!exists) { result = { found: false }; break; }
      let indexes = [];
      try { indexes = coll().getIndexes().map((i) => ({ name: i.name, key: out(i.key), unique: !!i.unique })); } catch (e) {}
      const fields = {};
      coll().find({}).limit(100).maxTimeMS(ms).forEach((doc) => {
        for (const [k, v] of Object.entries(doc)) {
          const t = v === null ? "null" : Array.isArray(v) ? "array" : v instanceof Date ? "date" : typeof v === "object" ? (v._bsontype || "object") : typeof v;
          (fields[k] = fields[k] || {})[t] = (fields[k][t] || 0) + 1;
        }
      });
      result = { found: true, indexes, fields };
      break;
    }
    case "documents": {
      const filter = ej(input.filter, {});
      const sort = ej(input.sort, null);
      let c = coll().find(filter).maxTimeMS(ms).skip(input.skip).limit(input.limit);
      if (sort) c = c.sort(sort);
      const found = c.toArray();
      const total = coll().countDocuments(filter, { limit: input.countCap + 1, maxTimeMS: ms });
      result = { docs: found.map(out), versions: found.map(version), total: Number(total) };
      break;
    }
    case "find": {
      result = take(coll().find(ej(input.query, {})).maxTimeMS(ms).limit(input.limit + 1), input.limit);
      break;
    }
    case "aggregate": {
      const pipeline = ej(input.query, []);
      if (!Array.isArray(pipeline)) throw new Error("A pipeline is a list of stages, like [{ \\"$match\\": {} }].");
      if (input.readOnly && writes(pipeline)) throw new Error("$out and $merge write to a collection, so they are not allowed in read only mode.");
      result = take(coll().aggregate(pipeline, { maxTimeMS: ms }), input.limit);
      break;
    }
    case "count": {
      result = { count: Number(coll().countDocuments(ej(input.query, {}), { maxTimeMS: ms })) };
      break;
    }
    case "distinct": {
      const values = coll().distinct(input.field, ej(input.query, {}), { maxTimeMS: ms });
      result = { docs: values.slice(0, input.limit).map((v) => out({ value: v })), more: values.length > input.limit };
      break;
    }
    case "insert": {
      const docs = ej(input.query, null);
      const list = Array.isArray(docs) ? docs : [docs];
      if (!list.length || list.some((x) => !x || typeof x !== "object" || Array.isArray(x))) throw new Error("Insert takes a document or a list of documents.");
      const n = Object.keys(coll().insertMany(list).insertedIds).length;
      result = { affected: n, message: n + (n === 1 ? " document" : " documents") + " inserted" };
      break;
    }
    case "update": {
      const q = ej(input.query, null);
      if (!q || typeof q !== "object" || !q.filter || !q.update) throw new Error("Update takes { \\"filter\\": {…}, \\"update\\": {…} }.");
      const r = coll().updateMany(q.filter, q.update);
      result = { affected: Number(r.modifiedCount), message: r.modifiedCount + " changed of " + r.matchedCount + " matched" };
      break;
    }
    case "replace": {
      const id = ej(input.id, undefined);
      const doc = ej(input.query, null);
      if (id === undefined) throw new Error("The document has no _id.");
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("A document is an object, like { \\"name\\": \\"Ada\\" }.");
      if (doc._id !== undefined && EJSON.stringify(doc._id, { relaxed: false }) !== EJSON.stringify(id, { relaxed: false })) throw new Error("The _id of a document cannot change.");
      delete doc._id;
      if (!input.version) {
        // From the API without a version: saved over whatever the document holds now.
        const r = coll().replaceOne({ _id: id }, doc);
        result = { affected: Number(r.matchedCount), message: r.matchedCount ? "1 document saved" : "the document is gone" };
        break;
      }
      const current = coll().findOne({ _id: id });
      if (!current) { result = { affected: 0 }; break; }
      // Shown cut short, so the edit was made from the placeholder: saving it would lose the document.
      if (EJSON.stringify(current, { relaxed: false }).length > 200000) throw new Error("This document is too large to edit here. Change it in the Query tab.");
      if (version(current) !== input.version) { result = { affected: 0, stale: true }; break; }
      // The filter matches the document as just read, so a change between the read and the write is not overwritten.
      const r = coll().replaceOne({ _id: id, $expr: { $eq: ["$$ROOT", { $literal: current }] } }, doc);
      result = r.matchedCount ? { affected: 1, message: "1 document saved" } : { affected: 0, stale: true };
      break;
    }
    case "delete": {
      const r = coll().deleteMany(ej(input.query, {}));
      result = { affected: Number(r.deletedCount), message: r.deletedCount + (r.deletedCount === 1 ? " document" : " documents") + " deleted" };
      break;
    }
    default:
      throw new Error("Unknown operation");
  }
} catch (e) {
  result = { error: String((e && (e.errmsg || e.message)) || e) };
}
print("SERVE_JSON" + JSON.stringify(result));
`;

export type MongoInput = {
  op: "overview" | "structure" | "documents" | "replace" | MongoOp;
  /** replace: the _id of the document, as Extended JSON. */
  id?: string;
  /** replace: the version of the document the edit was made from (as documents returned it). */
  version?: string;
  db: string;
  collection?: string;
  filter?: string;
  sort?: string;
  query?: string;
  field?: string;
  skip?: number;
  limit?: number;
  /** Refuse anything that writes (the browsing operations only read). */
  readOnly?: boolean;
};

export function mongoScript(c: EngineCreds, input: MongoInput, timeoutSeconds = QUERY_TIMEOUT) {
  const payload = { skip: 0, limit: QUERY_LIMIT, countCap: COUNT_CAP, readOnly: true, ...input, timeoutMs: timeoutSeconds * 1000 };
  return [
    `export SERVE_INPUT=${sh(b64(JSON.stringify(payload)))}`,
    `$T mongosh --quiet --norc${c.tlsRequired ? " --tls --tlsAllowInvalidCertificates" : ""} -u ${sh(c.username)} -p ${sh(c.password)} --authenticationDatabase admin admin --eval ${sh(MONGO_SCRIPT)}`,
  ];
}

/** The JSON line the mongosh script printed. */
export function parseMongo<T>(stdout: string): (T & { error?: undefined }) | { error: string } {
  const line = stdout.split("\n").find((l) => l.startsWith("SERVE_JSON"));
  if (!line) throw new Error("MongoDB did not answer.");
  return JSON.parse(line.slice("SERVE_JSON".length));
}

/**
 * Canonical Extended JSON made readable: plain numbers where a double holds them exactly, dates as
 * ISO strings; long integers and decimals stay wrapped, so nothing is rounded.
 */
export function readableEjson(canonical: string): string {
  const simplify = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(simplify);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 1) {
        const [k] = keys;
        const x = o[k];
        if (k === "$numberInt" && typeof x === "string") return Number(x);
        if (k === "$numberDouble" && typeof x === "string" && Number.isFinite(Number(x)) && String(Number(x)) === x.replace(/\.0$/, "").replace(/^-0$/, "0")) return Number(x);
        if (k === "$numberLong" && typeof x === "string" && Number.isSafeInteger(Number(x))) return Number(x);
        if (k === "$date" && x && typeof x === "object" && typeof (x as { $numberLong?: string }).$numberLong === "string") {
          const ms = Number((x as { $numberLong: string }).$numberLong);
          const d = new Date(ms);
          if (Number.isFinite(d.getTime()) && d.getUTCFullYear() >= 1970 && d.getUTCFullYear() <= 9999) return { $date: d.toISOString() };
        }
      }
      return Object.fromEntries(keys.map((key) => [key, simplify(o[key])]));
    }
    return v;
  };
  return JSON.stringify(simplify(JSON.parse(canonical)), null, 2);
}

/* ----------------------------------------------------------- Redis / Valkey */

/** Read-only commands of Redis and Valkey, allowed in read only mode. Subcommands are listed for the container commands. */
const KV_READ = new Set(
  (
    "GET MGET STRLEN GETRANGE SUBSTR LCS EXISTS TYPE TTL PTTL EXPIRETIME PEXPIRETIME DBSIZE SCAN RANDOMKEY " +
    "HGET HMGET HGETALL HKEYS HVALS HLEN HEXISTS HSTRLEN HSCAN HRANDFIELD HTTL HPTTL HEXPIRETIME HPEXPIRETIME " +
    "LRANGE LINDEX LLEN LPOS SMEMBERS SISMEMBER SMISMEMBER SCARD SSCAN SRANDMEMBER SINTER SUNION SDIFF SINTERCARD " +
    "ZRANGE ZRANGEBYSCORE ZREVRANGE ZREVRANGEBYSCORE ZRANGEBYLEX ZREVRANGEBYLEX ZSCORE ZMSCORE ZCARD ZCOUNT ZLEXCOUNT ZRANK ZREVRANK ZSCAN ZRANDMEMBER ZINTER ZUNION ZDIFF ZINTERCARD " +
    "XRANGE XREVRANGE XLEN XPENDING BITCOUNT BITPOS GETBIT BITFIELD_RO PFCOUNT GEOPOS GEODIST GEOHASH GEOSEARCH GEORADIUS_RO GEORADIUSBYMEMBER_RO SORT_RO " +
    "EVAL_RO EVALSHA_RO FCALL_RO INFO PING ECHO TIME LASTSAVE ROLE"
  ).split(" "),
);
const KV_READ_SUB: Record<string, Set<string>> = {
  OBJECT: new Set(["ENCODING", "FREQ", "IDLETIME", "REFCOUNT", "HELP"]),
  MEMORY: new Set(["USAGE", "STATS", "DOCTOR", "MALLOC-STATS", "HELP"]),
  XINFO: new Set(["STREAM", "GROUPS", "CONSUMERS", "HELP"]),
  CLIENT: new Set(["LIST", "INFO", "GETNAME", "ID", "HELP"]),
  COMMAND: new Set(["COUNT", "INFO", "DOCS", "LIST", "GETKEYS", "GETKEYSANDFLAGS", "HELP"]),
  SLOWLOG: new Set(["GET", "LEN", "HELP"]),
  LATENCY: new Set(["LATEST", "HISTORY", "DOCTOR", "HISTOGRAM", "HELP"]),
  PUBSUB: new Set(["CHANNELS", "NUMSUB", "NUMPAT", "SHARDCHANNELS", "SHARDNUMSUB", "HELP"]),
  FUNCTION: new Set(["LIST", "STATS", "HELP"]),
  SCRIPT: new Set(["EXISTS", "HELP"]),
  MODULE: new Set(["LIST", "HELP"]),
};
/** Never run from here: they never return, change the connection, or stop the server. */
const KV_NEVER = new Set([
  "MONITOR",
  "SUBSCRIBE",
  "PSUBSCRIBE",
  "SSUBSCRIBE",
  "UNSUBSCRIBE",
  "PUNSUBSCRIBE",
  "SUNSUBSCRIBE",
  "SYNC",
  "PSYNC",
  "SELECT",
  "AUTH",
  "HELLO",
  "RESET",
  "QUIT",
  "SHUTDOWN",
  "DEBUG",
]);

export const kvReadOnlyCommands = () => [...KV_READ, ...Object.entries(KV_READ_SUB).flatMap(([c, subs]) => [...subs].map((s) => `${c} ${s}`))].sort();

/** Splits a command line like redis-cli does: spaces separate, "…" takes \n, \t, \xHH and \" escapes, '…' takes \'. */
export function tokenizeCommand(line: string): Buffer[] {
  const args: Buffer[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && /\s/.test(line[i])) i++;
    if (i >= n) break;
    const bytes: number[] = [];
    const add = (s: string) => bytes.push(...Buffer.from(s, "utf8"));
    if (line[i] === '"') {
      i++;
      let closed = false;
      while (i < n) {
        const c = line[i];
        if (c === "\\" && i + 1 < n) {
          const e = line[i + 1];
          if (e === "x" && /^[0-9a-fA-F]{2}$/.test(line.slice(i + 2, i + 4))) {
            bytes.push(Number.parseInt(line.slice(i + 2, i + 4), 16));
            i += 4;
            continue;
          }
          add({ n: "\n", r: "\r", t: "\t", b: "\b", a: "\x07" }[e] ?? e);
          i += 2;
        } else if (c === '"') {
          closed = true;
          i++;
          break;
        } else {
          add(c);
          i++;
        }
      }
      if (!closed || (i < n && !/\s/.test(line[i]))) throw new ExplorerInputError("Unbalanced quotes in the command.");
    } else if (line[i] === "'") {
      i++;
      let closed = false;
      while (i < n) {
        if (line[i] === "\\" && line[i + 1] === "'") {
          add("'");
          i += 2;
        } else if (line[i] === "'") {
          closed = true;
          i++;
          break;
        } else add(line[i++]);
      }
      if (!closed || (i < n && !/\s/.test(line[i]))) throw new ExplorerInputError("Unbalanced quotes in the command.");
    } else {
      let word = "";
      while (i < n && !/\s/.test(line[i])) word += line[i++];
      add(word);
    }
    args.push(Buffer.from(bytes));
  }
  return args;
}

/** Whether a command may run, and why not. */
export function checkKvCommand(args: Buffer[], readOnly: boolean): string | null {
  if (!args.length) return "Write a command first.";
  const name = args[0].toString("latin1").toUpperCase();
  if (!/^[A-Z][A-Z0-9_.|-]*$/.test(name)) return "Start with a command name, like GET or SCAN.";
  if (KV_NEVER.has(name)) return name === "SELECT" ? "Choose the database above instead of SELECT." : `${name} cannot run from here.`;
  if (!readOnly) return null;
  const subs = KV_READ_SUB[name];
  if (subs) {
    const sub = args[1]?.toString("latin1").toUpperCase() ?? "";
    return subs.has(sub) ? null : `${name} ${sub || "…"} is not allowed in read only mode. Allowed: ${[...subs].map((s) => `${name} ${s}`).join(", ")}.`;
  }
  if (KV_READ.has(name)) return null;
  // Reads every key at once: on a big database it stops the server for everyone until it ends.
  if (name === "KEYS") return "KEYS can stop a big database while it runs. Use SCAN (or the key list) instead.";
  return `${name} can change data, so it is not allowed in read only mode. Allow changes to run it.`;
}

/** An argument for redis-cli --quoted-input: "…" with every byte that is not plain printable ASCII as \xHH. */
export const kvQuote = (arg: Buffer | string) => {
  const bytes = typeof arg === "string" ? Buffer.from(arg, "utf8") : arg;
  let s = '"';
  for (const b of bytes) s += b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c && b !== 0x27 ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`;
  return `${s}"`;
};

const kvBin = (engine: string) => (engine === "valkey" ? "valkey-cli" : "redis-cli");
function kvRun(engine: string, c: EngineCreds, database: number, args: (Buffer | string)[]) {
  if (!Number.isInteger(database) || database < 0 || database > 255) throw new ExplorerInputError("Unknown database number.");
  return [
    `export REDISCLI_AUTH=${sh(c.password)} VALKEYCLI_AUTH=${sh(c.password)}`,
    `$T ${kvBin(engine)} --no-auth-warning${c.tlsRequired ? " --tls --insecure" : ""} --quoted-input --quoted-json -n ${database} ${args.map((a) => sh(kvQuote(a))).join(" ")}`,
  ];
}

/** Bytes from redis-cli's quoted form (the inside of "…" with \xHH, \n, \\ escapes). */
export function unquoteKv(s: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      const e = s[i + 1];
      if (e === "x" && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) {
        bytes.push(Number.parseInt(s.slice(i + 2, i + 4), 16));
        i += 3;
        continue;
      }
      bytes.push(...Buffer.from({ n: "\n", r: "\r", t: "\t", b: "\b", a: "\x07" }[e] ?? e, "utf8"));
      i++;
    } else bytes.push(...Buffer.from(c, "utf8"));
  }
  return Buffer.from(bytes);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
/** A Redis value for display: its text when it is UTF-8, else its quoted form ("\xff…"). */
export function kvText(quoted: string): string {
  const bytes = unquoteKv(quoted);
  try {
    const text = utf8.decode(bytes);
    // Control characters other than newlines and tabs read better quoted; text that looks quoted is
    // quoted too, so kvBytes can tell the two apart.
    if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) && !/^"[\s\S]*"$/.test(text)) return text;
  } catch {}
  return kvQuote(bytes);
}

/** The bytes of a value shown by kvText (a key picked in the list, say). */
export const kvBytes = (shown: string) => (/^"[\s\S]*"$/.test(shown) ? unquoteKv(shown.slice(1, -1)) : Buffer.from(shown, "utf8"));

/** Decodes every string of a --quoted-json reply. */
export function kvDecode(v: unknown): unknown {
  if (typeof v === "string") return kvText(v);
  if (Array.isArray(v)) return v.map(kvDecode);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [kvText(k), kvDecode(x)]));
  return v;
}

export type KvReply = { error: string } | { value: unknown } | { text: string };
/** One reply of redis-cli --quoted-json. */
export function parseKvReply(stdout: string): KvReply {
  const text = stdout.replace(/\n$/, "");
  if (text.startsWith("error:")) {
    try {
      return { error: kvText(JSON.parse(text.slice(6)) as string) };
    } catch {
      return { error: text.slice(6) };
    }
  }
  try {
    return { value: kvDecode(parseJsonExact(text)) };
  } catch {
    // Some replies (INFO) are printed as plain text.
    return { text };
  }
}

const KV_SCAN = `
local cursor = ARGV[1]
local out = {}
local rounds = 0
repeat
  local r = redis.call('SCAN', cursor, 'MATCH', ARGV[2], 'COUNT', 500)
  cursor = r[1]
  for _, k in ipairs(r[2]) do
    local t = redis.call('TYPE', k)['ok']
    local size = -1
    if t == 'string' then size = redis.call('STRLEN', k)
    elseif t == 'hash' then size = redis.call('HLEN', k)
    elseif t == 'list' then size = redis.call('LLEN', k)
    elseif t == 'set' then size = redis.call('SCARD', k)
    elseif t == 'zset' then size = redis.call('ZCARD', k)
    elseif t == 'stream' then size = redis.call('XLEN', k) end
    out[#out + 1] = {k, t, redis.call('PTTL', k), size}
  end
  rounds = rounds + 1
until cursor == '0' or #out >= tonumber(ARGV[3]) or rounds >= 20
return {cursor, out}
`;

const KV_KEY = `
local k = KEYS[1]
local t = redis.call('TYPE', k)['ok']
local ttl = redis.call('PTTL', k)
local at = ARGV[1]
local n = tonumber(ARGV[2])
if t == 'string' then return {t, ttl, redis.call('STRLEN', k), '0', redis.call('GETRANGE', k, 0, tonumber(ARGV[3]) - 1)}
elseif t == 'hash' then local r = redis.call('HSCAN', k, at, 'COUNT', n) return {t, ttl, redis.call('HLEN', k), r[1], r[2]}
elseif t == 'set' then local r = redis.call('SSCAN', k, at, 'COUNT', n) return {t, ttl, redis.call('SCARD', k), r[1], r[2]}
elseif t == 'list' then local s = tonumber(at) return {t, ttl, redis.call('LLEN', k), tostring(s + n), redis.call('LRANGE', k, s, s + n - 1)}
elseif t == 'zset' then local s = tonumber(at) return {t, ttl, redis.call('ZCARD', k), tostring(s + n), redis.call('ZRANGE', k, s, s + n - 1, 'WITHSCORES')}
elseif t == 'stream' then
  local r = redis.call('XRANGE', k, at == '0' and '-' or '(' .. at, '+', 'COUNT', n)
  local flat = {}
  for _, e in ipairs(r) do flat[#flat + 1] = e[1]; flat[#flat + 1] = e[2] end
  local nextAt = '0'
  if #r == n then nextAt = r[#r][1] end
  return {t, ttl, redis.call('XLEN', k), nextAt, flat}
end
return {t, ttl, -1, '0', {}}
`;

export type KeyInfo = { key: string; type: string; ttl: number; size: number };
export type KeyValue = {
  key: string;
  type: string;
  /** Milliseconds; -1 never expires, -2 gone. */
  ttl: number;
  size: number;
  /** Where the next page starts ("0": no more). */
  next: string;
  /** string: [value]; hash: [field, value]; list: [index, value]; set: [member]; zset: [member, score]; stream: [id, fields]. */
  entries: string[][];
  truncated: boolean;
};
/** Bytes of a string value shown at most. */
export const MAX_STRING = 64 * 1024;

export const kvScanScript = (engine: string, c: EngineCreds, database: number, cursor: string, pattern: string) => {
  if (!/^\d+$/.test(cursor)) throw new ExplorerInputError("Unexpected cursor.");
  return kvRun(engine, c, database, ["EVAL_RO", KV_SCAN, "0", cursor, pattern || "*", "100"]);
};

export function parseKvScan(stdout: string): { cursor: string; keys: KeyInfo[] } {
  const reply = parseKvReply(stdout);
  if ("error" in reply) throw new Error(reply.error);
  if (!("value" in reply)) throw new Error("Unexpected reply.");
  const [cursor, list] = reply.value as [string, [string, string, number, number][]];
  return { cursor: String(cursor), keys: (list ?? []).map(([key, type, ttl, size]) => ({ key, type, ttl: Number(ttl), size: Number(size) })) };
}

export const kvKeyScript = (engine: string, c: EngineCreds, database: number, key: Buffer, at: string) => {
  if (!/^(\d+|\d+-\d+)$/.test(at)) throw new ExplorerInputError("Unexpected position.");
  return kvRun(engine, c, database, ["EVAL_RO", KV_KEY, "1", key, at, String(PAGE_SIZE), String(MAX_STRING)]);
};

export function parseKvKey(stdout: string, key: string): KeyValue {
  const reply = parseKvReply(stdout);
  if ("error" in reply) throw new Error(reply.error);
  if (!("value" in reply)) throw new Error("Unexpected reply.");
  const [type, ttl, size, next, data] = reply.value as [string, number, number, string, unknown];
  const list = Array.isArray(data) ? (data as unknown[]) : [data];
  const pairs = (step: number) => {
    const out: string[][] = [];
    for (let i = 0; i < list.length; i += step) out.push(list.slice(i, i + step).map((v) => String(v ?? "")));
    return out;
  };
  let entries: string[][];
  if (type === "string") entries = [[String(data ?? "")]];
  else if (type === "hash" || type === "zset") entries = pairs(2);
  else if (type === "stream") {
    entries = [];
    for (let i = 0; i < list.length; i += 2) {
      const parts = Array.isArray(list[i + 1]) ? (list[i + 1] as string[]) : [];
      const fields: Record<string, string> = {};
      for (let j = 0; j < parts.length; j += 2) fields[parts[j]] = parts[j + 1] ?? "";
      entries.push([String(list[i]), JSON.stringify(fields)]);
    }
  } else if (type === "list") {
    const start = Number(next) - PAGE_SIZE;
    entries = list.map((v, i) => [String(start + i), String(v ?? "")]);
  } else entries = list.map((v) => [String(v ?? "")]);
  return { key, type, ttl: Number(ttl), size: Number(size), next: type === "string" ? "0" : String(next), entries, truncated: type === "string" && Number(size) > MAX_STRING };
}

export const kvKeyspaceScript = (engine: string, c: EngineCreds) => kvRun(engine, c, 0, ["INFO", "keyspace"]);

/** Databases with keys, from INFO keyspace (database 0 always). */
export function parseKeyspace(stdout: string): { name: string; size: number | null }[] {
  const found = new Map<number, number>([[0, 0]]);
  for (const m of stdout.matchAll(/db(\d+):keys=(\d+)/g)) found.set(Number(m[1]), Number(m[2]));
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([n, keys]) => ({ name: String(n), size: keys }));
}

export const kvCommandScript = (engine: string, c: EngineCreds, database: number, args: Buffer[]) => kvRun(engine, c, database, args);

/* ------------------------------------------------------------ Editing a row */

export type CellEdit = {
  database: string;
  schema: string | null;
  table: string;
  /** The row's primary key: every column of it, with the values the row showed. */
  key: { column: string; value: string }[];
  column: string;
  /** null sets NULL. */
  value: string | null;
  /** The value the row showed in this column, with the column's type: a row changed since is not overwritten. */
  original?: { value: Cell; type: string };
};

/** Types whose values the rows show as hex or text that would not write back as they read. */
export const NOT_EDITABLE = /blob|binary|^bit\b|geometry|point|polygon|linestring/i;

/**
 * Conditions that a row still holds the values it showed (`original`, with each column's type), so
 * a save does not overwrite a change someone made since. Values whose text does not compare back
 * exactly are left out: binary ones, ones cut short, and floating point numbers on MySQL (FLOAT
 * reads back rounded). Long values compare by their MD5, to keep the script short.
 */
export function unchangedConditions(engine: "postgres" | "mysql" | "mariadb", original: Record<string, { value: Cell; type: string }> | undefined): string[] {
  const out: string[] = [];
  const md5 = (v: string) => `'${crypto.createHash("md5").update(v, "utf8").digest("hex")}'`;
  for (const [column, { value, type }] of Object.entries(original ?? {})) {
    if (NOT_EDITABLE.test(type) || cappedCell(value)) continue;
    if (engine === "postgres") {
      const id = pgIdent(column);
      if (value === null) out.push(`${id} IS NULL`);
      // json and xml have no = operator; their text is what the rows showed. char(n) loses its padding as text.
      else if (value.length > 1000 && !/^(character|char|bpchar)\b(?! varying)/i.test(type)) out.push(`md5(${id}::text) = ${md5(value)}`);
      else if (/json|xml/i.test(type)) out.push(`${id}::text = ${pgLiteral(value)}`);
      // The text takes the column's type: 't' reads as true, a timestamp in the session's time zone.
      else out.push(`${id} = ${pgLiteral(value)}`);
    } else {
      if (/float|double|real/i.test(type)) continue;
      const id = myIdent(column);
      if (value === null) out.push(`${id} IS NULL`);
      else if (value.length > 1000) out.push(`MD5(CAST(${id} AS CHAR)) = ${md5(value)}`);
      else if (/json/i.test(type)) out.push(`CAST(${id} AS CHAR) = ${myLiteral(value)}`);
      else out.push(`${id} = ${myLiteral(value)}`);
    }
  }
  return out;
}

/**
 * Sets one value of one row, found by its whole primary key (so at most one row). Prints how many
 * rows matched: none means the row changed or went since it was shown.
 */
export function editCellScript(engine: "postgres" | "mysql" | "mariadb", c: EngineCreds, edit: CellEdit): string[] {
  if (!edit.key.length) throw new ExplorerInputError("Only rows of a table with a primary key can be changed here.");
  const unchanged = unchangedConditions(engine, edit.original ? { [edit.column]: edit.original } : undefined);
  if (engine === "postgres") {
    const where = [...edit.key.map((k) => `${pgIdent(k.column)} = ${pgLiteral(k.value)}`), ...unchanged].join(" AND ");
    const sql = `UPDATE ${pgIdent(edit.schema ?? "public")}.${pgIdent(edit.table)} SET ${pgIdent(edit.column)} = ${edit.value === null ? "NULL" : pgLiteral(edit.value)} WHERE ${where}`;
    return [...pgEnv(c, { readOnly: false, timeoutSeconds: QUERY_TIMEOUT }), shVar("U", sql), `${psql(c, edit.database, "-At")} -c "$U" -c '\\echo SERVE_ROWS :ROW_COUNT'`];
  }
  const where = [...edit.key.map((k) => `${myIdent(k.column)} = ${myLiteral(k.value)}`), ...unchanged].join(" AND ");
  const table = `${myIdent(edit.database)}.${myIdent(edit.table)}`;
  const cli = myCli(engine, c, "-N -B -r");
  return [
    ...cli.env,
    `${pipe(
      [
        myTimeout(engine, QUERY_TIMEOUT),
        "START TRANSACTION;",
        // Matched rows, not changed ones: a value set to what it was is still found.
        `SELECT CONCAT('SERVE_ROWS ', COUNT(*)) FROM ${table} WHERE ${where};`,
        `UPDATE ${table} SET ${myIdent(edit.column)} = ${edit.value === null ? "NULL" : myLiteral(edit.value)} WHERE ${where} LIMIT 1;`,
        "COMMIT;",
      ].join("\n"),
    )} | ${cli.cmd}`,
  ];
}

/** Changes to one table, saved together: all of them or none. */
export type TableChanges = {
  database: string;
  schema: string | null;
  table: string;
  /**
   * A row found by its whole primary key, with the new values of some columns (null sets NULL).
   * original: the values the row showed (with each column's type); a row that holds others now is stale.
   */
  updates: { key: { column: string; value: string }[]; values: Record<string, string | null>; original?: Record<string, { value: Cell; type: string }> }[];
  /** New rows: the columns given; the others get their defaults. */
  inserts: { values: Record<string, string | null> }[];
  deletes: { key: { column: string; value: string }[]; original?: Record<string, { value: Cell; type: string }> }[];
};

/**
 * One transaction for all the changes. A row to change or delete that is not there any more (or
 * not found by its key) stops it before anything is saved: the error names it as SERVE_STALE <n>,
 * counting updates, then deletes, from 1.
 */
export function changesScript(engine: "postgres" | "mysql" | "mariadb", c: EngineCreds, ch: TableChanges): string[] {
  const steps = ch.updates.length + ch.inserts.length + ch.deletes.length;
  if (!steps) throw new ExplorerInputError("There are no changes to save.");
  if ([...ch.updates, ...ch.deletes].some((r) => !r.key.length)) throw new ExplorerInputError("Only rows of a table with a primary key can be changed here.");
  if (ch.updates.some((u) => !Object.keys(u.values).length) || ch.inserts.some((i) => !Object.keys(i.values).length)) throw new ExplorerInputError("A change has no values.");
  if (engine === "postgres") {
    const table = `${pgIdent(ch.schema ?? "public")}.${pgIdent(ch.table)}`;
    const value = (v: string | null) => (v === null ? "NULL" : pgLiteral(v));
    const where = (row: TableChanges["deletes"][number]) =>
      [...row.key.map((k) => `${pgIdent(k.column)} = ${pgLiteral(k.value)}`), ...unchangedConditions(engine, row.original)].join(" AND ");
    // A dollar tag no value can end: chosen until none of the statements contains it.
    const statements: string[] = [];
    const checked: string[] = [];
    let n = 0;
    for (const u of ch.updates)
      checked.push(
        `UPDATE ${table} SET ${Object.entries(u.values)
          .map(([col, v]) => `${pgIdent(col)} = ${value(v)}`)
          .join(", ")} WHERE ${where(u)};\n  IF NOT FOUND THEN RAISE EXCEPTION 'SERVE_STALE ${++n}'; END IF;`,
      );
    for (const d of ch.deletes) checked.push(`DELETE FROM ${table} WHERE ${where(d)};\n  IF NOT FOUND THEN RAISE EXCEPTION 'SERVE_STALE ${++n}'; END IF;`);
    let tag = "serve";
    while (checked.some((x) => x.includes(`$${tag}$`))) tag = `serve_${crypto.randomBytes(4).toString("hex")}`;
    if (checked.length) statements.push(`DO $${tag}$ BEGIN\n  ${checked.join("\n  ")}\nEND $${tag}$;`);
    for (const i of ch.inserts) {
      const cols = Object.keys(i.values);
      statements.push(`INSERT INTO ${table} (${cols.map(pgIdent).join(", ")}) VALUES (${cols.map((col) => value(i.values[col])).join(", ")});`);
    }
    // One -c with several statements is one transaction: an error in any undoes all.
    return [...pgEnv(c, { readOnly: false, timeoutSeconds: QUERY_TIMEOUT }), shVar("U", statements.join("\n")), `${psql(c, ch.database, "-At")} -c "$U" -c '\\echo SERVE_SAVED'`];
  }
  const table = `${myIdent(ch.database)}.${myIdent(ch.table)}`;
  const value = (v: string | null) => (v === null ? "NULL" : myLiteral(v));
  const where = (row: TableChanges["deletes"][number]) =>
    [...row.key.map((k) => `${myIdent(k.column)} = ${myLiteral(k.value)}`), ...unchangedConditions(engine, row.original)].join(" AND ");
  // MySQL has no conditional error outside stored programs: a subquery of two rows in a scalar
  // place fails (1242), so a row not found stops the script, and the transaction is undone.
  const found = (n: number, row: TableChanges["deletes"][number]) =>
    `SELECT IF((SELECT COUNT(*) FROM ${table} WHERE ${where(row)}) = 1, 'ok', (SELECT 'SERVE_STALE ${n}' UNION ALL SELECT 'SERVE_STALE ${n}')) INTO @serve_found;`;
  const lines = [myTimeout(engine, QUERY_TIMEOUT), "START TRANSACTION;"];
  let n = 0;
  for (const u of ch.updates) {
    lines.push(`SELECT 'SERVE_STEP ${++n}';`, found(n, u));
    lines.push(
      `UPDATE ${table} SET ${Object.entries(u.values)
        .map(([col, v]) => `${myIdent(col)} = ${value(v)}`)
        .join(", ")} WHERE ${where(u)} LIMIT 1;`,
    );
  }
  for (const d of ch.deletes) {
    lines.push(`SELECT 'SERVE_STEP ${++n}';`, found(n, d));
    lines.push(`DELETE FROM ${table} WHERE ${where(d)} LIMIT 1;`);
  }
  for (const i of ch.inserts) {
    const cols = Object.keys(i.values);
    lines.push(`INSERT INTO ${table} (${cols.map(myIdent).join(", ")}) VALUES (${cols.map((col) => value(i.values[col])).join(", ")});`);
  }
  lines.push("COMMIT;", "SELECT 'SERVE_SAVED';");
  const cli = myCli(engine, c, "-N -B -r");
  return [...cli.env, `${pipe(lines.join("\n"))} | ${cli.cmd}`];
}

/** Which change stopped a save (1-based, updates then deletes), or null. */
export function staleChange(engine: string, output: string): number | null {
  const named = /SERVE_STALE (\d+)/.exec(output);
  if (named) return Number(named[1]);
  // MySQL: the subquery error, after the last step it printed.
  if (engine !== "postgres" && /ERROR 1242/.test(output)) {
    const steps = [...output.matchAll(/SERVE_STEP (\d+)/g)];
    return steps.length ? Number(steps.at(-1)![1]) : 1;
  }
  return null;
}

export function parseEditCount(stdout: string) {
  const m = /SERVE_ROWS (\d+)/.exec(stdout);
  return m ? Number(m[1]) : null;
}

/* ------------------------------------------------------------- Per engine */

export type BrowseScripts = {
  overview: (database: string) => string[];
  structure: (table: { schema: string | null; name: string; database: string }) => string[];
  rows: (
    table: { schema: string | null; name: string; database: string; order?: string[] },
    page: number,
    sort: RowSort | null,
    filter: RowFilter | null,
    nullMarker: string,
  ) => string[];
  query: (database: string, sql: string, opts: Opts, marker: string) => string[];
};

export function sqlScripts(engine: "postgres" | "mysql" | "mariadb" | "clickhouse", c: EngineCreds): BrowseScripts {
  switch (engine) {
    case "postgres":
      return {
        overview: (database) => pgOverview(c, database),
        structure: (t) => pgStructure(c, t.database, t.schema ?? "public", t.name),
        rows: (t, page, sort, filter, marker) => pgRows(c, t.database, t.schema ?? "public", t.name, page, sort, t.order ?? [], filter, marker),
        query: (database, sql, opts, marker) => pgQuery(c, database, sql, { ...opts, nullMarker: marker }),
      };
    case "mysql":
    case "mariadb":
      return {
        overview: (database) => myOverview(engine, c, database),
        structure: (t) => myStructure(engine, c, t.database, t.name),
        rows: (t, page, sort, filter) => myRows(engine, c, t.database, t.name, page, sort, t.order ?? [], filter),
        query: (database, sql, opts, marker) => myQuery(engine, c, database, sql, opts, marker),
      };
    case "clickhouse":
      return {
        overview: (database) => chOverview(c, database),
        structure: (t) => chStructure(c, t.database, t.name),
        rows: (t, page, sort, filter) => chRows(c, t.database, t.name, page, sort, t.order ?? [], filter),
        query: (database, sql, opts) => {
          if (!sql.trim()) throw new ExplorerInputError("Write a query first.");
          return chRun(c, database, sql, { ...opts, limit: QUERY_LIMIT });
        },
      };
  }
}

/** Parses an overview's output for SQL engines. */
export function parseSqlOverview(engine: string, stdout: string, database: string): Overview {
  if (engine === "postgres") {
    const j = JSON.parse(stdout) as { databases: Overview["databases"]; schemas: string[]; tables: (Omit<TableInfo, "kind"> & { kind: string })[] };
    return { databases: j.databases, database, schemas: j.schemas, tables: j.tables.map((t) => ({ ...t, kind: PG_KINDS[t.kind] ?? t.kind })) };
  }
  if (engine === "clickhouse") {
    const [dbs, tables] = parseClickhouseJson(stdout) ?? [];
    return {
      databases: (dbs?.rows ?? []).map(([name, size]) => ({ name: String(name), size: size === null || size === undefined ? null : Number(size) })),
      database,
      schemas: [],
      tables: (tables?.rows ?? []).map(([name, kind, rows, bytes]) => ({
        schema: null,
        name: String(name),
        kind: String(kind),
        rows: rows === null ? null : Number(rows),
        bytes: bytes === null ? null : Number(bytes),
      })),
    };
  }
  const j = JSON.parse(stdout.trim() || "{}") as {
    databases: { name: string; size: number | string | null }[] | null;
    tables: { name: string; kind: string; rows: number | null; bytes: number | null }[] | null;
  };
  return {
    databases: (j.databases ?? []).map((d) => ({ name: d.name, size: d.size === null ? null : Number(d.size) })).sort((a, b) => a.name.localeCompare(b.name)),
    database,
    schemas: [],
    tables: (j.tables ?? [])
      .map((t) => ({
        schema: null,
        name: t.name,
        kind: t.kind === "BASE TABLE" ? "table" : t.kind === "VIEW" || t.kind === "SYSTEM VIEW" ? "view" : t.kind.toLowerCase(),
        rows: t.rows,
        bytes: t.bytes,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function parseSqlStructure(engine: string, stdout: string): Structure | null {
  if (engine === "postgres") {
    const j = JSON.parse(stdout) as { found: boolean } & Structure;
    return j.found ? { columns: j.columns, indexes: j.indexes } : null;
  }
  if (engine === "clickhouse") return parseChStructure(parseClickhouseJson(stdout) ?? []);
  return parseMyStructure(JSON.parse(stdout.trim()));
}
