import crypto from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decrypt, encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { logActivity } from "@/server/activity";
import { enqueue, type JobPayloads } from "@/server/queue";
import { serverOf } from "@/server/servers/context";
import { execCommand } from "@/server/services/exec";
import { databaseContainer } from "./container";
import { databaseCreds, databaseUrl } from "./options";
import { engines, mongoToolsTls, mongoTls, rcli } from "./engines";
import { privateHost } from "@/lib/hostname";
import { branchDatabaseName, previewBranchName, branchReference } from "@/lib/database-branches";
import { parseListing, userScripts } from "./users";

type Service = typeof schema.service.$inferSelect;
type Branch = typeof schema.databaseBranch.$inferSelect;

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Branch databases and roles are made of [a-z0-9_] only (branchDatabaseName), so plain quoting is safe. */
const ident = (s: string) => {
  if (!/^[a-z0-9_]+$/.test(s)) throw new Error(`Unexpected name ${s}`);
  return `"${s}"`;
};
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
/**
 * User-written SQL (the preview scrub) on a pipe, as base64: a heredoc could be ended by a line
 * of the text, and the rest would run as shell commands in the database container.
 */
export const pipeSql = (sql: string) => `printf '%s' '${Buffer.from(sql, "utf8").toString("base64")}' | base64 -d`;

/** A branch name that cannot be used; shown to the person who chose it. */
export class BranchNameError extends Error {}

export function branchesSupported(service: Pick<Service, "type" | "database">) {
  return service.type === "database" && !!service.database;
}

/** Redis and Valkey branches are database numbers 1 to 15 of the same server. */
export const isKeyValue = (engine: string) => engine === "redis" || engine === "valkey";
/** Engines whose branches can run clean-up SQL after the copy. */
export const branchScrubEngines = new Set(["postgres", "mysql", "mariadb", "clickhouse"]);
export const maxBranches = (engine: string) => (isKeyValue(engine) ? 15 : 20);

type Main = { username: string; password: string; database: string; tlsRequired?: boolean };
type BranchCreds = { database: string; username: string; password: string };

/* ------------------------------------------------------------- MySQL / MariaDB */

function mysqlScripts(cli: "mysql" | "mariadb") {
  const dump = cli === "mysql" ? "mysqldump" : "mariadb-dump";
  const run = (database?: string) => `${cli} -uroot${database ? ` ${q(database)}` : ""}`;
  const user = (b: BranchCreds) => `${literal(b.username)}@'%'`;
  return {
    create: (main: Main, b: BranchCreds, scrubSql: string | null) =>
      [
        "set -e",
        // dash (Debian images) exits on an unknown set option, even with || true: test in a subshell first.
        "(set -o pipefail) 2>/dev/null && set -o pipefail",
        // Read by the client tools; keeps the password off the command line.
        `export MYSQL_PWD=${q(main.password)}`,
        `${run()} <<'SERVE_SQL'
DROP DATABASE IF EXISTS \`${b.database}\`;
CREATE DATABASE \`${b.database}\`;
CREATE USER IF NOT EXISTS ${user(b)} IDENTIFIED BY ${literal(b.password)};
ALTER USER ${user(b)} IDENTIFIED BY ${literal(b.password)};
GRANT ALL PRIVILEGES ON \`${b.database}\`.* TO ${user(b)};
FLUSH PRIVILEGES;
SERVE_SQL`,
        // Without DEFINER clauses, routines and views run as whoever calls them: the branch's user.
        `${dump} -uroot --single-transaction --routines --triggers --events ${q(main.database)} | sed -e 's/DEFINER=\`[^\`]*\`@\`[^\`]*\`//g' | ${run(b.database)}`,
        // As the branch's user: the clean-up SQL can touch the branch and nothing else.
        ...(scrubSql?.trim() ? [`${pipeSql(scrubSql)} | MYSQL_PWD=${q(b.password)} ${cli} -u${q(b.username)} ${q(b.database)}`] : []),
        `echo "SERVE_SIZE=$(${run()} -N -B -e "SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = ${literal(b.database)}")"`,
      ].join("\n"),
    remove: (main: Main, b: BranchCreds) =>
      [
        "set -e",
        `export MYSQL_PWD=${q(main.password)}`,
        `${run()} <<'SERVE_SQL'
DROP DATABASE IF EXISTS \`${b.database}\`;
DROP USER IF EXISTS ${user(b)};
SERVE_SQL`,
      ].join("\n"),
  };
}

/* ------------------------------------------------------------------- MongoDB */

const mongoScripts = {
  create: (main: Main, b: BranchCreds) => {
    const auth = `-u ${q(main.username)} -p ${q(main.password)} --authenticationDatabase admin`;
    const c = { username: main.username, password: main.password, database: main.database, tlsRequired: !!main.tlsRequired };
    const js = `const d = db.getSiblingDB(${JSON.stringify(b.database)});
const roles = [{ role: "dbOwner", db: ${JSON.stringify(b.database)} }];
if (d.getUser(${JSON.stringify(b.username)})) d.updateUser(${JSON.stringify(b.username)}, { pwd: ${JSON.stringify(b.password)}, roles });
else d.createUser({ user: ${JSON.stringify(b.username)}, pwd: ${JSON.stringify(b.password)}, roles });
print("SERVE_SIZE=" + d.stats().totalSize);`;
    return [
      "set -e",
      // dash (Debian images) exits on an unknown set option, even with || true: test in a subshell first.
      "(set -o pipefail) 2>/dev/null && set -o pipefail",
      `mongosh --quiet${mongoTls(c)} ${auth} --eval ${q(`db.getSiblingDB(${JSON.stringify(b.database)}).dropDatabase()`)} >/dev/null`,
      `mongodump --quiet${mongoToolsTls(c)} ${auth} --db ${q(main.database)} --archive | mongorestore --quiet${mongoToolsTls(c)} ${auth} --archive --nsFrom ${q(`${main.database}.*`)} --nsTo ${q(`${b.database}.*`)}`,
      `mongosh --quiet${mongoTls(c)} ${auth} --eval ${q(js)}`,
    ].join("\n");
  },
  remove: (main: Main, b: BranchCreds) => {
    const c = { username: main.username, password: main.password, database: main.database, tlsRequired: !!main.tlsRequired };
    const js = `const d = db.getSiblingDB(${JSON.stringify(b.database)}); try { d.dropUser(${JSON.stringify(b.username)}); } catch (e) {} d.dropDatabase();`;
    return `set -e\nmongosh --quiet${mongoTls(c)} -u ${q(main.username)} -p ${q(main.password)} --authenticationDatabase admin --eval ${q(js)}`;
  },
};

/* ---------------------------------------------------------------- ClickHouse */

const clickhouseScripts = {
  create: (main: Main, b: BranchCreds, scrubSql: string | null) => {
    const ch = `clickhouse-client -u ${q(main.username)} --password ${q(main.password)}`;
    const from = main.database.replace(/`/g, "");
    const stores = "(engine LIKE '%MergeTree' OR engine IN ('Log', 'TinyLog', 'StripeLog', 'Memory'))";
    return [
      "set -e",
      // dash (Debian images) exits on an unknown set option, even with || true: test in a subshell first.
      "(set -o pipefail) 2>/dev/null && set -o pipefail",
      `ch() { ${ch} "$@"; }`,
      `ch -q ${q(`DROP DATABASE IF EXISTS \`${b.database}\` SYNC`)}`,
      `ch -q ${q(`CREATE DATABASE \`${b.database}\``)}`,
      // Tables first, copied with their rows; then plain views, pointed at the branch's tables.
      `ch -q ${q(`SELECT name FROM system.tables WHERE database = ${literal(from)} AND NOT is_temporary AND name NOT LIKE '.inner%' AND ${stores} ORDER BY name FORMAT TSVRaw`)} | while IFS= read -r t; do
  # A backquoted name ends at a backquote: escape it (and backslashes) in the table's name.
  t=$(printf '%s' "$t" | sed 's/[\\\\\`]/\\\\&/g')
  ch -q "CREATE TABLE \\\`${b.database}\\\`.\\\`$t\\\` AS \\\`${from}\\\`.\\\`$t\\\`"
  ch -q "INSERT INTO \\\`${b.database}\\\`.\\\`$t\\\` SELECT * FROM \\\`${from}\\\`.\\\`$t\\\`"
done`,
      `ch -q ${q(`SELECT replaceRegexpAll(create_table_query, '\\\\b${from}\\\\.', '${b.database}.') FROM system.tables WHERE database = ${literal(from)} AND engine = 'View' ORDER BY name FORMAT TSVRaw`)} | while IFS= read -r v; do ch -q "$v"; done`,
      `ch -q ${q(`CREATE USER IF NOT EXISTS \`${b.username}\` IDENTIFIED WITH sha256_password BY ${literal(b.password)}`)}`,
      `ch -q ${q(`ALTER USER \`${b.username}\` IDENTIFIED WITH sha256_password BY ${literal(b.password)}`)}`,
      `ch -q ${q(`GRANT ALL ON \`${b.database}\`.* TO \`${b.username}\``)}`,
      ...(scrubSql?.trim() ? [`${pipeSql(scrubSql)} | clickhouse-client -u ${q(b.username)} --password ${q(b.password)} -d ${q(b.database)} --multiquery`] : []),
      `echo "SERVE_SIZE=$(ch -q ${q(`SELECT sum(bytes_on_disk) FROM system.parts WHERE database = ${literal(b.database)} AND active`)})"`,
    ].join("\n");
  },
  remove: (main: Main, b: BranchCreds) => {
    const ch = `clickhouse-client -u ${q(main.username)} --password ${q(main.password)}`;
    return ["set -e", `${ch} -q ${q(`DROP DATABASE IF EXISTS \`${b.database}\` SYNC`)}`, `${ch} -q ${q(`DROP USER IF EXISTS \`${b.username}\``)}`].join("\n");
  },
};

/* ------------------------------------------------------------ Redis / Valkey */

function keyValueScripts(bin: "redis-cli" | "valkey-cli") {
  return {
    create: (main: Main, b: BranchCreds) => {
      const n = Number(b.database);
      if (!Number.isInteger(n) || n < 1 || n > 15) throw new Error(`Unexpected database number ${b.database}`);
      const cli = rcli(bin, { username: main.username, password: main.password, database: "0", tlsRequired: !!main.tlsRequired });
      // The main data is database 0; a branch made from another branch copies that branch's number.
      const from = /^\d+$/.test(main.database) ? Number(main.database) : 0;
      if (from === n) throw new Error("A branch cannot copy itself.");
      // A Lua loop in batches of 1000 keys: any key name works, and the server never blocks for long.
      const lua = "local r = redis.call('SCAN', ARGV[1], 'COUNT', 1000) for _, k in ipairs(r[2]) do redis.call('COPY', k, k, 'DB', ARGV[2], 'REPLACE') end return r[1]";
      return [
        "set -e",
        `${cli} -n ${n} FLUSHDB >/dev/null`,
        "cursor=0",
        // redis-cli exits 0 on an error reply, so the reply itself is checked: anything but a number stops the copy.
        `while :; do cursor=$(${cli} -n ${from} EVAL ${q(lua)} 0 "$cursor" ${n}); case "$cursor" in '' | *[!0-9]*) echo "$cursor" >&2; exit 1 ;; esac; [ "$cursor" = "0" ] && break; done`,
        `echo "SERVE_KEYS=$(${cli} -n ${n} DBSIZE)"`,
      ].join("\n");
    },
    remove: (main: Main, b: BranchCreds) => {
      const n = Number(b.database);
      if (!Number.isInteger(n) || n < 1 || n > 15) throw new Error(`Unexpected database number ${b.database}`);
      return `set -e\n${rcli(bin, { username: main.username, password: main.password, database: "0", tlsRequired: !!main.tlsRequired })} -n ${n} FLUSHDB >/dev/null`;
    },
  };
}

/** The scripts that create and remove a branch inside a database container of this engine. */
export function branchScripts(engine: string): { create: (main: Main, b: BranchCreds, scrubSql: string | null) => string; remove: (main: Main, b: BranchCreds) => string } {
  switch (engine) {
    case "postgres":
      return { create: createScript, remove: deleteScript };
    case "mysql":
      return mysqlScripts("mysql");
    case "mariadb":
      return mysqlScripts("mariadb");
    case "mongodb":
      return mongoScripts;
    case "clickhouse":
      return clickhouseScripts;
    case "redis":
      return keyValueScripts("redis-cli");
    case "valkey":
      return keyValueScripts("valkey-cli");
    default:
      throw new Error(`Branches are not available for ${engine}.`);
  }
}

/**
 * Hand every object of the branch to its role, so its login can change the schema. Statements
 * that cannot apply (objects of extensions) are skipped.
 */
const ownershipSql = (role: string) => `DO $serve$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT format('ALTER SCHEMA %I OWNER TO %I', nspname, ${literal(role)}) AS stmt FROM pg_namespace
      WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
    UNION ALL
    SELECT format('ALTER %s %s OWNER TO %I',
        CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
        c.oid::regclass, ${literal(role)})
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    UNION ALL
    SELECT format('ALTER ROUTINE %s OWNER TO %I', p.oid::regprocedure, ${literal(role)})
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
    UNION ALL
    SELECT format('ALTER TYPE %s OWNER TO %I', t.oid::regtype, ${literal(role)})
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' AND t.typtype IN ('d', 'e', 'r')
  LOOP
    BEGIN
      EXECUTE r.stmt;
    EXCEPTION WHEN others THEN NULL;
    END;
  END LOOP;
END
$serve$;`;

/** Shell script that (re)creates a branch: an empty database owned by its role, filled with a copy of the main one. */
export function createScript(
  main: { username: string; password: string; database: string },
  branch: { database: string; username: string; password: string },
  scrubSql: string | null,
) {
  // Query results are not needed; errors still go to stderr.
  const psql = (database: string, quiet = true) => `psql -X -v ON_ERROR_STOP=1 -q${quiet ? " -o /dev/null" : ""} -U ${q(main.username)} -d ${q(database)}`;
  const dropDb = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${literal(branch.database)} AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS ${ident(branch.database)};`;
  return [
    "set -e",
    // dash (Debian images) exits on an unknown set option, even with || true: test in a subshell first.
    "(set -o pipefail) 2>/dev/null && set -o pipefail",
    `export PGPASSWORD=${q(main.password)}`,
    `${psql(main.database)} <<'SERVE_SQL'
${dropDb}
DO $serve$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${literal(branch.username)}) THEN
    CREATE ROLE ${ident(branch.username)} LOGIN PASSWORD ${literal(branch.password)};
  ELSE
    ALTER ROLE ${ident(branch.username)} LOGIN PASSWORD ${literal(branch.password)};
  END IF;
END $serve$;
CREATE DATABASE ${ident(branch.database)} OWNER ${ident(branch.username)};
REVOKE CONNECT ON DATABASE ${ident(branch.database)} FROM PUBLIC;
SERVE_SQL`,
    // Streams inside the container: nothing is written to disk but the new database.
    `pg_dump -U ${q(main.username)} -d ${q(main.database)} -Fc --no-owner --no-privileges | pg_restore -U ${q(main.username)} -d ${q(branch.database)} --no-owner --no-privileges --exit-on-error`,
    `${psql(branch.database)} <<'SERVE_SQL'
${ownershipSql(branch.username)}
SERVE_SQL`,
    // As the branch's role, which owns the branch and nothing else.
    ...(scrubSql?.trim()
      ? [`${pipeSql(scrubSql)} | PGPASSWORD=${q(branch.password)} psql -X -v ON_ERROR_STOP=1 -q -o /dev/null -U ${q(branch.username)} -d ${q(branch.database)}`]
      : []),
    `echo "SERVE_SIZE=$(${psql(main.database, false)} -At -c "SELECT pg_database_size(${literal(branch.database)})")"`,
  ].join("\n");
}

export function deleteScript(main: { username: string; password: string; database: string }, branch: { database: string; username: string }) {
  return [
    "set -e",
    `export PGPASSWORD=${q(main.password)}`,
    `psql -X -v ON_ERROR_STOP=1 -q -o /dev/null -U ${q(main.username)} -d ${q(main.database)} <<'SERVE_SQL'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${literal(branch.database)} AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS ${ident(branch.database)};
DROP ROLE IF EXISTS ${ident(branch.username)};
SERVE_SQL`,
  ].join("\n");
}

async function run(service: Service, script: string, secrets: string[]) {
  const { docker } = await serverOf(service);
  const container = await databaseContainer(docker, service);
  const res = await execCommand(container.id, script, { docker, timeoutSeconds: 4 * 3600 });
  let output = res.output;
  for (const s of secrets) if (s) output = output.replaceAll(s, "***");
  if (res.timedOut) throw new Error("The copy took longer than 4 hours and was stopped.");
  if (res.exitCode !== 0) throw new Error(output.trim().split("\n").slice(-6).join("\n") || `Exited with code ${res.exitCode}`);
  return output;
}

/* ------------------------------------------------- Every database of the server */

/** Engines whose branches can copy every database of the server, not only the main one. */
export const allDatabaseEngines = new Set(["postgres", "mysql", "mariadb", "mongodb", "clickhouse"]);

/** The databases of the server, without the engine's own (the listing of the Users page; ClickHouse here). */
function listDatabasesScript(engine: string, main: Main) {
  if (engine === "clickhouse")
    return `clickhouse-client -u ${q(main.username)} --password ${q(main.password)} -q "SELECT concat('SERVE_DB', char(9), name) FROM system.databases WHERE name NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') FORMAT TSVRaw"`;
  return userScripts(engine, { username: main.username, password: main.password, database: main.database, tlsRequired: !!main.tlsRequired }).list();
}

/** Removes one copied database (the branch's login stays: the main copy still has it). */
function dropCopyScript(engine: string, main: Main, database: string) {
  switch (engine) {
    case "postgres":
      return `set -e\nexport PGPASSWORD=${q(main.password)}\npsql -X -v ON_ERROR_STOP=1 -q -o /dev/null -U ${q(main.username)} -d ${q(main.database)} <<'SERVE_SQL'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${literal(database)} AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS ${ident(database)};
SERVE_SQL`;
    case "mysql":
    case "mariadb":
      return `set -e\nexport MYSQL_PWD=${q(main.password)}\n${engine} -uroot -e ${q(`DROP DATABASE IF EXISTS \`${database}\``)}`;
    case "mongodb": {
      const c = { username: main.username, password: main.password, database: main.database, tlsRequired: !!main.tlsRequired };
      return `set -e\nmongosh --quiet${mongoTls(c)} -u ${q(main.username)} -p ${q(main.password)} --authenticationDatabase admin --eval ${q(`db.getSiblingDB(${JSON.stringify(database)}).dropDatabase()`)}`;
    }
    case "clickhouse":
      return `set -e\nclickhouse-client -u ${q(main.username)} --password ${q(main.password)} -q ${q(`DROP DATABASE IF EXISTS \`${database}\` SYNC`)}`;
    default:
      throw new Error(`Branches of ${engine} have one database.`);
  }
}

/**
 * MongoDB: the branch's login lives in its main copy; it becomes the owner of every copy there,
 * and the logins each copy's script made in the other copies go.
 */
function mongoOwnAllScript(main: Main, branch: BranchCreds, copies: string[]) {
  const c = { username: main.username, password: main.password, database: main.database, tlsRequired: !!main.tlsRequired };
  const js = `const home = db.getSiblingDB(${JSON.stringify(branch.database)});
const roles = ${JSON.stringify([branch.database, ...copies].map((d) => ({ role: "dbOwner", db: d })))};
home.updateUser(${JSON.stringify(branch.username)}, { roles });
for (const d of ${JSON.stringify(copies)}) { try { db.getSiblingDB(d).dropUser(${JSON.stringify(branch.username)}); } catch (e) {} }`;
  return `set -e\nmongosh --quiet${mongoTls(c)} -u ${q(main.username)} -p ${q(main.password)} --authenticationDatabase admin --eval ${q(js)}`;
}

/** A copied database's name: the original's and the branch's, like the main copy. */
export const copyDatabaseName = (database: string, branch: string) => branchDatabaseName(database, branch);

/**
 * The other databases a branch copies now: every database of the server but the main one, the
 * engine's own and every branch's copies. A copy name that is a database of its own (or that two
 * databases would share) stops the copy: the copy would drop that database first.
 */
async function otherDatabases(service: Service, branch: Branch, main: Main) {
  const engine = service.database!.engine;
  const out = await run(service, listDatabasesScript(engine, main), [main.password]);
  const found = parseListing(engine, out).databases;
  const siblings = await db.select().from(schema.databaseBranch).where(eq(schema.databaseBranch.serviceId, service.id));
  const copies = new Set(siblings.flatMap((b) => [b.database, ...b.extraDatabases.map((d) => copyDatabaseName(d, b.name))]));
  const extras = found.filter((d) => d !== main.database && !copies.has(d)).sort();
  const names = new Map<string, string>();
  for (const d of [main.database, ...extras]) {
    const copy = copyDatabaseName(d, branch.name);
    if (names.has(copy)) throw new Error(`${names.get(copy)} and ${d} would both be copied as ${copy}. Rename one of them.`);
    names.set(copy, d);
    const own = d === main.database ? branch.database : copy;
    if (found.includes(own) && !copies.has(own))
      throw new Error(`The copy of ${d} would replace the database ${own}, which is not a copy. Rename it, or choose another branch name.`);
  }
  return extras;
}

/** Add a branch and queue its copy. */
export async function createBranch(
  service: Service,
  name: string,
  opts: { userId?: string | null; previewServiceId?: string | null; scrubbed?: boolean; sourceBranchId?: string | null; allDatabases?: boolean } = {},
) {
  if (!branchesSupported(service) || !service.database) throw new Error("Branches are available for database services.");
  const engine = service.database.engine;
  let database = branchDatabaseName(service.database.database, name);
  let username = database;
  if (isKeyValue(engine)) {
    // The number is picked with the row inserted, below.
    username = "default";
  } else if (engine === "mysql" || engine === "mariadb") {
    // MySQL user names are at most 32 characters.
    username = database.length <= 32 ? database : `${database.slice(0, 27)}_${crypto.createHash("sha256").update(database).digest("hex").slice(0, 4)}`;
  }
  // A login made on the Users page with this name would be taken over (its password changed).
  const [taken] = await db
    .select({ id: schema.databaseUser.id })
    .from(schema.databaseUser)
    .where(and(eq(schema.databaseUser.serviceId, service.id), eq(schema.databaseUser.username, username)));
  if (taken && !isKeyValue(engine)) throw new BranchNameError(`The database user ${username} uses this name. Choose another branch name.`);
  // The copy drops the branch's database first, and deleting the branch drops it too: a database of
  // that name made some other way (a migration, the Query tab) would be lost.
  if (!isKeyValue(engine) && service.status === "running") {
    const main = databaseCreds(service.database, decrypt(service.database.password));
    const found = parseListing(engine, await run(service, listDatabasesScript(engine, main), [main.password])).databases;
    if (found.includes(database)) throw new BranchNameError(`${service.name} has a database named ${database} already. Choose another branch name.`);
  }
  try {
    // One branch of a service at a time: two made at once would pick the same database number.
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`serve-branch:${service.id}`}))`);
      if (isKeyValue(engine)) {
        // The lowest free database number; 0 is the main data.
        const used = new Set(
          (await tx.select({ database: schema.databaseBranch.database }).from(schema.databaseBranch).where(eq(schema.databaseBranch.serviceId, service.id))).map((b) => b.database),
        );
        const free = Array.from({ length: 15 }, (_, i) => String(i + 1)).find((n) => !used.has(n));
        if (!free) throw new Error("All 15 database numbers are in use. Delete a branch first.");
        database = free;
      }
      const [branch] = await tx
        .insert(schema.databaseBranch)
        .values({
          id: newId(),
          serviceId: service.id,
          name,
          database,
          username,
          // Redis and Valkey have no per-database logins: their branches use the main password.
          password: encrypt(isKeyValue(engine) ? "" : crypto.randomBytes(18).toString("base64url")),
          createdBy: opts.userId ?? null,
          previewServiceId: opts.previewServiceId ?? null,
          scrubbed: opts.scrubbed ?? false,
          sourceBranchId: opts.sourceBranchId ?? null,
          allDatabases: opts.allDatabases ?? false,
        })
        .returning();
      return branch;
    });
  } catch (e) {
    // Made at the same moment under the same name: the unique index caught it.
    if (uniqueViolation(e)) throw new BranchNameError(`A branch named ${name} exists already.`);
    throw e;
  }
}

const uniqueViolation = (error: unknown) => [(error as { code?: string }).code, (error as { cause?: { code?: string } }).cause?.code].includes("23505");

export const enqueueBranchJob = (payload: JobPayloads["database.branch"], serviceId: string) =>
  enqueue("database.branch", payload, { concurrencyKey: `branch:${serviceId}`, maxAttempts: 1 });

/** Job: create, refill or remove a branch inside its database container. */
export async function runBranchJob(payload: JobPayloads["database.branch"]) {
  const [branch] = await db.select().from(schema.databaseBranch).where(eq(schema.databaseBranch.id, payload.branchId));
  if (!branch) return;
  const [service] = await db.select().from(schema.service).where(eq(schema.service.id, branch.serviceId));
  if (!service?.database) return;
  const mainPassword = decrypt(service.database.password);
  const main = { ...databaseCreds(service.database, mainPassword) };
  const branchPassword = decrypt(branch.password);
  const scripts = branchScripts(service.database.engine);

  if (payload.op === "delete") {
    // The row goes only once the branch's login and data are gone: a stopped database keeps both,
    // and a login Serve forgot would stay valid (preview branches hand theirs to pull request code).
    try {
      if (service.status !== "running") throw new Error("The database is not running. Start it, then delete the branch again.");
      // The other copies first: the main copy's removal also removes the login they use.
      for (const d of branch.extraDatabases) await run(service, dropCopyScript(service.database.engine, main, copyDatabaseName(d, branch.name)), [mainPassword]);
      await run(service, scripts.remove(main, { ...branch, password: branchPassword }), [mainPassword, branchPassword]);
    } catch (e) {
      await db
        .update(schema.databaseBranch)
        .set({ status: "failed", error: `Not deleted: ${(e as Error).message.slice(0, 1900)}`, updatedAt: new Date() })
        .where(eq(schema.databaseBranch.id, branch.id));
      return;
    }
    await db.delete(schema.databaseBranch).where(eq(schema.databaseBranch.id, branch.id));
    return;
  }

  try {
    if (service.status !== "running") throw new Error(`${service.name} is not running. Start it, then reset the branch.`);
    // Every copy (a reset too) of a branch that hides personal data runs the clean-up SQL.
    const scrubSql = await branchCleanupSql(service, branch, payload.preview?.previewId);
    const source = await sourceOf(branch);
    const out = await run(
      service,
      scripts.create(source ? { ...main, database: source.database } : main, { database: branch.database, username: branch.username, password: branchPassword }, scrubSql),
      [mainPassword, branchPassword],
    );
    let size = Number(out.match(/SERVE_SIZE=(\d+)/)?.[1] ?? Number.NaN);
    let extras = branch.extraDatabases;
    if (branch.allDatabases) {
      const engine = service.database.engine;
      // Every other database of the server, each copied as <database>__<branch> with the same login;
      // from a branch of every database, its copies of them.
      extras = source ? source.extraDatabases : await otherDatabases(service, branch, main);
      // Recorded before copying: a copy that fails half way is still removed with the branch.
      await db
        .update(schema.databaseBranch)
        .set({ extraDatabases: [...new Set([...branch.extraDatabases, ...extras])] })
        .where(eq(schema.databaseBranch.id, branch.id));
      const creds = { username: branch.username, password: branchPassword };
      for (const d of extras) {
        const from = source ? copyDatabaseName(d, source.name) : d;
        const copied = await run(service, scripts.create({ ...main, database: from }, { database: copyDatabaseName(d, branch.name), ...creds }, null), [
          mainPassword,
          branchPassword,
        ]);
        const n = Number(copied.match(/SERVE_SIZE=(\d+)/)?.[1] ?? Number.NaN);
        if (Number.isFinite(n) && Number.isFinite(size)) size += n;
      }
      // Databases removed from the server since the last copy: their copies go too.
      for (const d of branch.extraDatabases.filter((x) => !extras.includes(x))) await run(service, dropCopyScript(engine, main, copyDatabaseName(d, branch.name)), [mainPassword]);
      if (engine === "mongodb")
        await run(
          service,
          mongoOwnAllScript(
            main,
            { database: branch.database, ...creds },
            extras.map((d) => copyDatabaseName(d, branch.name)),
          ),
          [mainPassword, branchPassword],
        );
    }
    await db
      .update(schema.databaseBranch)
      .set({
        status: "ready",
        error: null,
        copiedAt: new Date(),
        sizeBytes: Number.isFinite(size) ? size : null,
        scrubbed: !!scrubSql?.trim(),
        extraDatabases: extras,
        updatedAt: new Date(),
      })
      .where(eq(schema.databaseBranch.id, branch.id));
    await logActivity({
      projectId: service.projectId,
      action: payload.op === "reset" ? "database.branch-reset" : "database.branch-created",
      targetType: "service",
      targetId: service.id,
      message: `${payload.op === "reset" ? "Reset" : "Created"} branch ${branch.name} of ${service.name}`,
    });
  } catch (e) {
    const message = (e as Error).message.slice(0, 2000);
    await db.update(schema.databaseBranch).set({ status: "failed", error: message, updatedAt: new Date() }).where(eq(schema.databaseBranch.id, branch.id));
    // A preview without its database would start with an empty DATABASE_URL: it is not deployed.
    if (payload.preview) {
      await logActivity({
        projectId: service.projectId,
        action: "preview.database-failed",
        targetType: "service",
        targetId: payload.preview.previewId,
        message: `The preview was not deployed: copying ${service.name} into branch ${branch.name} failed (${message.split("\n")[0].slice(0, 300)}).`,
      });
      return;
    }
    throw e;
  }
  if (payload.preview) {
    const { queueDeployment } = await import("@/server/services/create");
    await queueDeployment(payload.preview.previewId, "webhook", payload.preview.deployment);
  }
}

/** The branch a branch copies, when it was made from one; it must hold its data. */
async function sourceOf(branch: Branch) {
  if (!branch.sourceBranchId) return null;
  const [source] = await db.select().from(schema.databaseBranch).where(eq(schema.databaseBranch.id, branch.sourceBranchId));
  if (!source) return null;
  if (source.status !== "ready") throw new Error(`Branch ${source.name}, which this branch copies, is not ready. Try again when it is.`);
  return source;
}

/**
 * The clean-up SQL a copy into this branch runs: a preview's comes from its app's preview database
 * settings, a branch made with "hide personal data" uses the database's own. A branch that should
 * hide personal data but has no SQL to do it fails instead of holding a plain copy.
 */
async function branchCleanupSql(service: Service, branch: typeof schema.databaseBranch.$inferSelect, previewId?: string) {
  if (!branchScrubEngines.has(service.database!.engine)) {
    if (branch.scrubbed) throw new Error(`${engines[service.database!.engine].label} branches cannot run clean-up SQL.`);
    return null;
  }
  const preview = branch.previewServiceId ?? previewId;
  if (preview) return previewScrubSql(preview);
  if (!branch.scrubbed) return null;
  const sql = service.database!.branchCleanupSql?.trim();
  if (!sql) throw new Error("This branch hides personal data, but the database has no clean-up SQL. Add it on the Branches page, then reset the branch.");
  return sql;
}

async function previewScrubSql(previewId: string) {
  const [preview] = await db.select({ parentServiceId: schema.service.parentServiceId }).from(schema.service).where(eq(schema.service.id, previewId));
  if (!preview?.parentServiceId) return null;
  const [parent] = await db.select({ previewDatabase: schema.service.previewDatabase }).from(schema.service).where(eq(schema.service.id, preview.parentServiceId));
  return parent?.previewDatabase?.scrubSql ?? null;
}

/** Queue removal of the branches that belong to these preview services. */
export async function removePreviewBranches(previewIds: string[]) {
  if (!previewIds.length) return;
  const rows = await db.select().from(schema.databaseBranch).where(inArray(schema.databaseBranch.previewServiceId, previewIds));
  for (const b of rows) {
    await db.update(schema.databaseBranch).set({ status: "deleting" }).where(eq(schema.databaseBranch.id, b.id));
    await enqueueBranchJob({ branchId: b.id, op: "delete" }, b.serviceId);
  }
}

/**
 * A pull request preview's own branch of the source database: created (or refilled) now, its
 * URL put into the preview's variable as a reference. Returns the branch to fill.
 */
export async function createPreviewBranch(preview: Service, source: Service, prNumber: number, variable: string) {
  // Redis and Valkey branches share the main password: pull request code would get production access.
  if (isKeyValue(source.database!.engine)) throw new Error("Redis and Valkey branches share the main password, so previews cannot use them. Choose a separate copy for previews.");
  const name = previewBranchName(prNumber);
  const [existing] = await db
    .select()
    .from(schema.databaseBranch)
    .where(and(eq(schema.databaseBranch.serviceId, source.id), eq(schema.databaseBranch.name, name)));
  // A branch made by hand with this name (before such names were kept for previews) is not taken
  // over: its data would be replaced, its login handed to the pull request, and it would go with the preview.
  if (existing?.createdBy && !existing.previewServiceId)
    throw new Error(`${source.name} has a branch named ${name} that was not made for previews. Delete it so the preview can make its own.`);
  const branch = existing
    ? (await db.update(schema.databaseBranch).set({ status: "resetting", previewServiceId: preview.id }).where(eq(schema.databaseBranch.id, existing.id)).returning())[0]
    : await createBranch(source, name, { previewServiceId: preview.id });
  const value = encrypt(branchReference(source.slug, name));
  await db
    .insert(schema.envVar)
    .values({ id: newId(), serviceId: preview.id, key: variable, value, buildTime: false, runtime: true })
    .onConflictDoUpdate({ target: [schema.envVar.serviceId, schema.envVar.key], set: { value } });
  return branch;
}

/** Variables each ready branch provides, keyed like `branches.<name>.DATABASE_URL`. */
/** The engine's own name for its URL variable, as the main database provides it too. */
const URL_ALIAS: Record<string, string> = { postgres: "POSTGRES_URL", mysql: "MYSQL_URL", mariadb: "MYSQL_URL", mongodb: "MONGO_URL", redis: "REDIS_URL", valkey: "REDIS_URL" };

export function branchVars(service: Service, branches: Branch[]): Record<string, string> {
  const cfg = service.database;
  if (!cfg) return {};
  const out: Record<string, string> = {};
  const host = privateHost(service);
  const portNumber = engines[cfg.engine].port;
  const port = String(portNumber);
  for (const b of branches) {
    if (b.status !== "ready" && b.status !== "resetting") continue;
    const keyValue = isKeyValue(cfg.engine);
    const password = keyValue ? decrypt(cfg.password) : decrypt(b.password);
    let url: string;
    if (keyValue) {
      // Same server and password, another database number.
      url = `${databaseUrl(cfg, databaseCreds(cfg, password), host, portNumber)}/${b.database}`;
    } else {
      url = databaseUrl({ ...cfg, username: b.username, database: b.database }, { ...databaseCreds(cfg, password), username: b.username, database: b.database }, host, portNumber);
      // A MongoDB branch user lives in the branch database, not in admin.
      if (cfg.engine === "mongodb") url = url.replace("authSource=admin", `authSource=${encodeURIComponent(b.database)}`);
    }
    const p = `branches.${b.name}.`;
    const alias = URL_ALIAS[cfg.engine];
    // Every database a branch copied: ${{db.branches.<name>.databases.<database>.DATABASE_URL}}.
    if (b.allDatabases && !keyValue) {
      for (const original of [cfg.database, ...b.extraDatabases]) {
        const copy = original === cfg.database ? b.database : copyDatabaseName(original, b.name);
        let other = databaseUrl({ ...cfg, username: b.username, database: copy }, { ...databaseCreds(cfg, password), username: b.username, database: copy }, host, portNumber);
        // A MongoDB branch login lives in its main copy.
        if (cfg.engine === "mongodb") other = other.replace("authSource=admin", `authSource=${encodeURIComponent(b.database)}`);
        out[`${p}databases.${original}.DATABASE_URL`] = other;
        out[`${p}databases.${original}.DATABASE`] = copy;
      }
    }
    Object.assign(out, {
      [`${p}DATABASE_URL`]: url,
      ...(alias ? { [`${p}${alias}`]: url } : {}),
      [`${p}HOST`]: host,
      [`${p}PORT`]: port,
      [`${p}USERNAME`]: b.username,
      [`${p}PASSWORD`]: password,
      [`${p}DATABASE`]: b.database,
    });
  }
  return out;
}
