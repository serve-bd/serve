import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { pgConnectLine } from "@/server/databases/engines";

/*
 * Restoring a plain SQL dump made elsewhere, often of a whole server (pg_dumpall, mysqldump
 * --all-databases): its users, roles and system databases would replace those of the database
 * Serve runs, and Serve's own login with them. The dump is cleaned on its way in:
 *
 * - Users, roles, grants and owners are left out. Everything restored belongs to the account
 *   Serve connects with.
 * - System databases (MySQL's mysql and sys, Postgres' template1) are left out.
 * - Restored into its own service, every database the dump names keeps its name, created when
 *   missing (empty ones too): the apps' code may name it. Content before any database (a plain
 *   single-database dump) goes into the service's database. Copied into another service, a dump
 *   with one database goes into that service's database.
 * - MySQL: the account apps connect with gets the databases the restore creates.
 *
 * Postgres COPY data passes through untouched.
 */

export type SqlEngine = "postgres" | "mysql" | "mariadb";

/** What a first read of the dump found: its databases that hold anything, in order. */
export type SqlPlan = { databases: string[]; cluster: boolean };

const MYSQL_SYSTEM = new Set(["mysql", "sys", "performance_schema", "information_schema"]);
const PG_SYSTEM = new Set(["template0", "template1"]);

/** Name in `\connect` lines: plain, "quoted", or -reuse-previous=on "dbname='name'". */
export function pgConnectTarget(line: string): string | null {
  const m = line.match(/^\\(?:connect|c)\s+(.+?)\s*$/);
  if (!m) return null;
  let arg = m[1].replace(/^-reuse-previous=\S+\s+/, "");
  if (arg.startsWith('"') && arg.endsWith('"')) arg = arg.slice(1, -1).replaceAll('""', '"');
  // A connection string: libpq escapes ' and \ with a backslash (pg_dumpall, Serve's own backups).
  const conninfo = arg.match(/^dbname='((?:[^'\\]|\\.|'')*)'$/);
  if (conninfo) return conninfo[1].replace(/\\(.)|''/g, (_m, c: string | undefined) => c ?? "'");
  return arg;
}

/** Name of the database a mysqldump line switches to or creates, or null. */
export function mysqlDatabaseOf(line: string): string | null {
  const m = line.match(/^(?:USE|CREATE DATABASE(?:\s*\/\*.*?\*\/)?(?:\s+IF NOT EXISTS)?)\s+`((?:[^`]|``)+)`/i) ?? line.match(/^-- Current Database: `((?:[^`]|``)+)`/);
  return m ? m[1].replaceAll("``", "`") : null;
}

const pgCopyStart = (line: string) => /^COPY\s.+\sFROM stdin;\s*$/i.test(line);
const pgContent = (line: string) => /^(CREATE|COPY|INSERT|ALTER TABLE|SELECT pg_catalog\.setval)\b/i.test(line) && !/^CREATE (DATABASE|ROLE|USER|GROUP)\b/i.test(line);
const mysqlContent = (line: string) => /^(CREATE TABLE|INSERT|CREATE .*VIEW|CREATE .*PROCEDURE|CREATE .*FUNCTION|CREATE .*TRIGGER|CREATE .*EVENT)\b/i.test(line);

/** Reads the dump once (line by line) to find which databases hold something. */
export async function planSql(engine: SqlEngine, lines: AsyncIterable<string> | Iterable<string>): Promise<SqlPlan> {
  const used: string[] = [];
  const mark = (db: string | null) => {
    if (db !== null && !used.includes(db)) used.push(db);
  };
  let current: string | null = null;
  let cluster = false;
  let copying = false;
  let n = 0;
  for await (const line of lines) {
    if (n++ < 20 && /PostgreSQL database cluster dump/.test(line)) cluster = true;
    if (engine === "postgres") {
      if (copying) {
        if (line === "\\.") copying = false;
        continue;
      }
      if (pgCopyStart(line)) {
        copying = true;
        mark(current ?? "");
        continue;
      }
      const target = pgConnectTarget(line);
      if (target !== null) {
        current = target;
        // A database the dump names counts even when empty; "postgres" only with content (every cluster dump has it).
        if (target !== "postgres") mark(target);
      } else if (pgContent(line)) mark(current ?? "");
    } else {
      const db = mysqlDatabaseOf(line);
      if (db !== null) {
        current = db;
        mark(db);
      } else if (mysqlContent(line)) mark(current ?? "");
    }
  }
  const system = engine === "postgres" ? PG_SYSTEM : MYSQL_SYSTEM;
  // "" is content before any database switch: it goes to the service's database.
  return { databases: used.filter((d) => !system.has(d)), cluster };
}

const pgQuote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const pgLiteral = (name: string) => `'${name.replaceAll("'", "''")}'`;
const myQuote = (name: string) => `\`${name.replaceAll("`", "``")}\``;

/** What the filter did, for the restore log. */
export type SqlFilterReport = { skipped: Set<string>; created: string[]; into: string | null };

/**
 * A line filter for one dump. `target` is the service's database. Returns the lines to send for
 * each line of the dump (none, the line itself, or replacements). `keepNames`: every database
 * keeps its name, even alone (a backup Serve took of chosen databases of this server).
 */
export function sqlLineFilter(engine: SqlEngine, plan: SqlPlan, target: string, opts: { keepNames?: boolean; user?: string } = {}) {
  const report: SqlFilterReport = { skipped: new Set(), created: [], into: null };
  const named = plan.databases.filter((d) => d !== "");
  // One database: its content goes into the service's database. Several: each keeps its name.
  const single = named.length <= 1 && !opts.keepNames;
  const map = (db: string) => (single || db === "" ? target : db);
  if (single && named[0] && named[0] !== target) report.into = named[0];

  let copying = false;
  let skipping = false;

  const userLine = (line: string) =>
    engine === "postgres"
      ? /^(CREATE|ALTER|DROP) (ROLE|USER|GROUP)\b/i.test(line) ||
        /^(GRANT|REVOKE)\b/i.test(line) ||
        /^ALTER DEFAULT PRIVILEGES\b/i.test(line) ||
        /^ALTER .+ OWNER TO .+;\s*$/i.test(line) ||
        /^SET (SESSION AUTHORIZATION|ROLE)\b/i.test(line) ||
        /^(CREATE|ALTER|DROP|COMMENT ON) DATABASE\b/i.test(line) ||
        /^\\(un)?restrict\b/.test(line)
      : /^(CREATE|ALTER|DROP|RENAME) USER\b/i.test(line) ||
        /^(GRANT|REVOKE)\b/i.test(line) ||
        /^SET PASSWORD\b/i.test(line) ||
        /^FLUSH PRIVILEGES\b/i.test(line) ||
        /^(CREATE|DROP) ROLE\b/i.test(line);

  const push = (line: string): string[] => {
    if (engine === "postgres") {
      if (copying) {
        if (line === "\\.") copying = false;
        return skipping ? [] : [line];
      }
      if (pgCopyStart(line)) {
        copying = true;
        return skipping ? [] : [line];
      }
      const to = pgConnectTarget(line);
      if (to !== null) {
        skipping = !plan.databases.includes(to);
        if (skipping) {
          if (!PG_SYSTEM.has(to) && to !== "postgres") report.skipped.add(to);
          return [];
        }
        const db = map(to);
        const out: string[] = [];
        if (db !== target && !report.created.includes(db)) {
          report.created.push(db);
          out.push(`SELECT ${pgLiteral(`CREATE DATABASE ${pgQuote(db)}`)} WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = ${pgLiteral(db)})\\gexec`);
        }
        out.push(pgConnectLine(db));
        return out;
      }
      if (skipping || userLine(line)) return [];
      return [line];
    }

    const db = mysqlDatabaseOf(line);
    if (db !== null) {
      skipping = MYSQL_SYSTEM.has(db) || !plan.databases.includes(db);
      if (skipping) {
        if (!MYSQL_SYSTEM.has(db)) report.skipped.add(db);
        return [];
      }
      const to = map(db);
      if (line.startsWith("--")) return [line];
      const out = [`CREATE DATABASE IF NOT EXISTS ${myQuote(to)};`];
      if (to !== target && !report.created.includes(to)) {
        report.created.push(to);
        // The account apps connect with only has its own database: open this one to it too.
        if (opts.user && opts.user !== "root") out.push(`GRANT ALL PRIVILEGES ON ${myQuote(to)}.* TO '${opts.user.replaceAll("'", "''")}'@'%';`);
      }
      // A dump that switches to a database without creating it: it may not exist here.
      if (/^USE\b/i.test(line)) out.push(`USE ${myQuote(to)};`);
      return out;
    }
    if (skipping || userLine(line)) return [];
    if (/^INSERT\b/i.test(line)) return [line];
    // Views, routines and triggers name the account that made them; it does not exist here.
    return [line.replace(/\s*DEFINER\s*=\s*(`[^`]*`|'[^']*'|\S+)@(`[^`]*`|'[^']*'|\S+)/i, "")];
  };

  return { push, report };
}

/** The line filter as a stream: bytes in, cleaned lines out. */
export function sqlFilterStream(filter: ReturnType<typeof sqlLineFilter>) {
  let rest = "";
  // A character split across two chunks is joined before the line is read.
  const decoder = new StringDecoder("utf8");
  const emit = (stream: Transform, line: string) => {
    for (const out of filter.push(line)) stream.push(`${out}\n`);
  };
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const lines = (rest + decoder.write(chunk)).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) emit(this, line.endsWith("\r") ? line.slice(0, -1) : line);
      cb();
    },
    flush(cb) {
      rest += decoder.end();
      if (rest) emit(this, rest);
      cb();
    },
  });
}
