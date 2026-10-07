import type { DatabaseConfig } from "@/server/services/types";
import type { DatabaseUserAccess } from "@/server/db/schema";
import { chClient, chIdent, type EngineCreds, mongoTls, pgDbname } from "./engines";

/** Engines whose logins the Users page manages. */
export const userEngines = new Set(["postgres", "mysql", "mariadb", "mongodb", "clickhouse"]);
export const usersSupported = (cfg: Pick<DatabaseConfig, "engine"> | null | undefined) => !!cfg && userEngines.has(cfg.engine);

/** Lowercase letters, digits and underscores, starting with a letter: safe as an identifier everywhere, and short enough for MySQL (32). */
export const USERNAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** Logins of the engine itself, never managed from the Users page. */
const SYSTEM_USERS: Record<string, RegExp> = {
  // serve_pooler and serve_replicator: the logins of the connection pooler and the read replica.
  postgres: /^(postgres|pg_.*|serve_pooler|serve_replicator)$/,
  mysql: /^(root|mysql\..*|healthcheck)$/,
  mariadb: /^(root|mariadb\.sys|mysql\..*|healthcheck)$/,
  mongodb: /^(__system)$/,
  clickhouse: /^default$/,
};
export const isSystemUser = (engine: string, name: string) => !!SYSTEM_USERS[engine]?.test(name);

/** Databases of the engine itself, not offered for access. */
const SYSTEM_DATABASES: Record<string, Set<string>> = {
  postgres: new Set(["postgres"]),
  mysql: new Set(["information_schema", "mysql", "performance_schema", "sys"]),
  mariadb: new Set(["information_schema", "mysql", "performance_schema", "sys"]),
  mongodb: new Set(["admin", "local", "config"]),
  clickhouse: new Set(["system", "INFORMATION_SCHEMA", "information_schema"]),
};

/** SQL on a pipe, as base64: a heredoc could be ended by a line of the text (a database name, say). */
const pipeSql = (sql: string) => `printf '%s' '${Buffer.from(sql, "utf8").toString("base64")}' | base64 -d`;
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
const pgIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const myIdent = (s: string) => `\`${s.replace(/`/g, "``")}\``;
const checkName = (name: string) => {
  if (!USERNAME_PATTERN.test(name)) throw new Error(`Unexpected user name ${name}`);
  return name;
};

export type UserListing = { users: string[]; databases: string[] };

/** Parses the SERVE_USER / SERVE_DB lines the list script prints. */
export function parseListing(engine: string, output: string): UserListing {
  const users = new Set<string>();
  const databases = new Set<string>();
  for (const line of output.split("\n")) {
    const [kind, ...rest] = line.replace(/\r$/, "").split("\t");
    const value = rest.join("\t");
    if (!value) continue;
    if (kind === "SERVE_USER") users.add(value);
    else if (kind === "SERVE_DB" && !SYSTEM_DATABASES[engine]?.has(value)) databases.add(value);
  }
  return { users: [...users].sort(), databases: [...databases].sort() };
}

export type UserScripts = {
  list: () => string;
  create: (name: string, password: string, access: DatabaseUserAccess, databases: string[]) => string;
  setPassword: (name: string, password: string) => string;
  setAccess: (name: string, access: DatabaseUserAccess, databases: string[]) => string;
  remove: (name: string) => string;
};

/* ---------------------------------------------------------------- PostgreSQL */

const PG_PRIVILEGES: Record<DatabaseUserAccess, { tables: string; sequences: string; schema: string; database: string }> = {
  read: { tables: "SELECT", sequences: "SELECT", schema: "USAGE", database: "CONNECT" },
  readwrite: { tables: "SELECT, INSERT, UPDATE, DELETE", sequences: "USAGE, SELECT, UPDATE", schema: "USAGE", database: "CONNECT, TEMPORARY" },
  owner: { tables: "ALL", sequences: "ALL", schema: "USAGE, CREATE", database: "ALL" },
};

function postgresScripts(main: EngineCreds): UserScripts {
  const psql = (database: string) => `psql -X -v ON_ERROR_STOP=1 -q -o /dev/null -U ${sh(main.username)} -d ${sh(pgDbname(database))}`;
  const run = (database: string, sql: string) => `${pipeSql(sql)} | ${psql(database)}`;
  const head = ["set -e", "(set -o pipefail) 2>/dev/null && set -o pipefail", `export PGPASSWORD=${sh(main.password)}`];
  // Every database a login can reach: privileges are kept per database.
  // Each name goes to -d as a connection string (like pgDbname: ' and \ escaped by a backslash), so
  // a database named like "host=x" is not read as connection options.
  const eachDatabase = (sql: string) =>
    `psql -X -At -U ${sh(main.username)} -d ${sh(pgDbname(main.database))} -c "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate" | while IFS= read -r d; do c=$(printf '%s' "$d" | sed ${sh("s/[\\\\']/\\\\&/g")}); ${pipeSql(sql)} | psql -X -v ON_ERROR_STOP=1 -q -o /dev/null -U ${sh(main.username)} -d "dbname='$c'"; done`;
  // Objects the login made go to the main user (nothing is lost), then its privileges go.
  const revokeAll = (name: string) => eachDatabase(`REASSIGN OWNED BY ${pgIdent(name)} TO ${pgIdent(main.username)};\nDROP OWNED BY ${pgIdent(name)};`);
  const grant = (name: string, access: DatabaseUserAccess, database: string) => {
    const p = PG_PRIVILEGES[access];
    const role = literal(name);
    const owner = literal(main.username);
    return run(
      database,
      `GRANT ${p.database} ON DATABASE ${pgIdent(database)} TO ${pgIdent(name)};
DO $serve$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' LOOP
    EXECUTE format('GRANT ${p.schema} ON SCHEMA %I TO %I', s, ${role});
    EXECUTE format('GRANT ${p.tables} ON ALL TABLES IN SCHEMA %I TO %I', s, ${role});
    EXECUTE format('GRANT ${p.sequences} ON ALL SEQUENCES IN SCHEMA %I TO %I', s, ${role});
    ${access === "read" ? "" : "EXECUTE format('GRANT EXECUTE ON ALL ROUTINES IN SCHEMA %I TO %I', s, " + role + ");"}
    -- Tables the main user makes later are covered too.
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT ${p.tables} ON TABLES TO %I', ${owner}, s, ${role});
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT ${p.sequences} ON SEQUENCES TO %I', ${owner}, s, ${role});
  END LOOP;
END
$serve$;`,
    );
  };
  return {
    list: () =>
      [
        ...head,
        `psql -X -At -U ${sh(main.username)} -d ${sh(pgDbname(main.database))} -c "SELECT 'SERVE_DB' || chr(9) || datname FROM pg_database WHERE datallowconn AND NOT datistemplate UNION ALL SELECT 'SERVE_USER' || chr(9) || rolname FROM pg_roles WHERE rolcanlogin"`,
      ].join("\n"),
    create: (name, password, access, databases) =>
      [...head, run(main.database, `CREATE ROLE ${pgIdent(checkName(name))} LOGIN PASSWORD ${literal(password)};`), ...databases.map((d) => grant(name, access, d))].join("\n"),
    setPassword: (name, password) => [...head, run(main.database, `ALTER ROLE ${pgIdent(checkName(name))} PASSWORD ${literal(password)};`)].join("\n"),
    setAccess: (name, access, databases) => [...head, revokeAll(checkName(name)), ...databases.map((d) => grant(name, access, d))].join("\n"),
    remove: (name) =>
      [
        ...head,
        // Its open sessions end first: a role with sessions cannot be dropped.
        run(main.database, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ${literal(checkName(name))};`),
        revokeAll(name),
        run(main.database, `DROP ROLE IF EXISTS ${pgIdent(name)};`),
      ].join("\n"),
  };
}

/* ----------------------------------------------------------- MySQL / MariaDB */

const MYSQL_PRIVILEGES: Record<DatabaseUserAccess, string> = {
  read: "SELECT, SHOW VIEW",
  readwrite: "SELECT, INSERT, UPDATE, DELETE, SHOW VIEW, EXECUTE, CREATE TEMPORARY TABLES, LOCK TABLES",
  owner: "ALL PRIVILEGES",
};

function mysqlScripts(cli: "mysql" | "mariadb", main: EngineCreds): UserScripts {
  // Root and the app user share the password Serve generated; root can grant on every database.
  const run = (sql: string) => [`export MYSQL_PWD=${sh(main.password)}`, `${pipeSql(sql)} | ${cli} -uroot`].join("\n");
  const user = (name: string) => `${literal(checkName(name))}@'%'`;
  const grants = (name: string, access: DatabaseUserAccess, databases: string[]) => databases.map((d) => `GRANT ${MYSQL_PRIVILEGES[access]} ON ${myIdent(d)}.* TO ${user(name)};`);
  const head = ["set -e", "(set -o pipefail) 2>/dev/null && set -o pipefail"];
  return {
    list: () =>
      [
        ...head,
        `export MYSQL_PWD=${sh(main.password)}`,
        `${cli} -uroot -N -B -r -e "SELECT CONCAT('SERVE_DB', CHAR(9), schema_name) FROM information_schema.schemata UNION ALL SELECT CONCAT('SERVE_USER', CHAR(9), user) FROM mysql.user WHERE host = '%'"`,
      ].join("\n"),
    create: (name, password, access, databases) =>
      [...head, run([`CREATE USER ${user(name)} IDENTIFIED BY ${literal(password)};`, ...grants(name, access, databases), "FLUSH PRIVILEGES;"].join("\n"))].join("\n"),
    setPassword: (name, password) => [...head, run(`ALTER USER ${user(name)} IDENTIFIED BY ${literal(password)};\nFLUSH PRIVILEGES;`)].join("\n"),
    setAccess: (name, access, databases) =>
      [...head, run([`REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${user(name)};`, ...grants(name, access, databases), "FLUSH PRIVILEGES;"].join("\n"))].join("\n"),
    remove: (name) => [...head, run(`DROP USER IF EXISTS ${user(name)};\nFLUSH PRIVILEGES;`)].join("\n"),
  };
}

/* ------------------------------------------------------------------- MongoDB */

const MONGO_ROLES: Record<DatabaseUserAccess, string> = { read: "read", readwrite: "readWrite", owner: "dbOwner" };

function mongoScripts(main: EngineCreds): UserScripts {
  // Logins live in admin, with roles on the databases they reach (like Serve's own).
  const run = (js: string) =>
    `mongosh --quiet${mongoTls(main)} -u ${sh(main.username)} -p ${sh(main.password)} --authenticationDatabase admin admin --eval ${sh(`const a = db.getSiblingDB("admin"); ${js}`)}`;
  const roles = (access: DatabaseUserAccess, databases: string[]) => JSON.stringify(databases.map((d) => ({ role: MONGO_ROLES[access], db: d })));
  return {
    list: () =>
      run(
        `db.adminCommand({ listDatabases: 1, nameOnly: true }).databases.forEach((d) => print("SERVE_DB\\t" + d.name)); a.runCommand({ usersInfo: 1 }).users.forEach((u) => print("SERVE_USER\\t" + u.user));`,
      ),
    create: (name, password, access, databases) =>
      run(`a.createUser({ user: ${JSON.stringify(checkName(name))}, pwd: ${JSON.stringify(password)}, roles: ${roles(access, databases)} });`),
    setPassword: (name, password) => run(`a.changeUserPassword(${JSON.stringify(checkName(name))}, ${JSON.stringify(password)});`),
    setAccess: (name, access, databases) => run(`a.updateUser(${JSON.stringify(checkName(name))}, { roles: ${roles(access, databases)} });`),
    remove: (name) => run(`a.dropUser(${JSON.stringify(checkName(name))});`),
  };
}

/* ---------------------------------------------------------------- ClickHouse */

const CLICKHOUSE_PRIVILEGES: Record<DatabaseUserAccess, string> = {
  read: "SELECT, SHOW, dictGet",
  readwrite: "SELECT, INSERT, ALTER UPDATE, ALTER DELETE, SHOW, dictGet",
  owner: "ALL",
};

function clickhouseScripts(main: EngineCreds): UserScripts {
  // The main login has access management (CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT); default always exists.
  const client = chClient({ ...main, database: "default" });
  const run = (sql: string) => `${pipeSql(sql)} | ${client} --multiquery`;
  const chLiteral = (s: string) => `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  const grants = (name: string, access: DatabaseUserAccess, databases: string[]) =>
    databases.map((d) => `GRANT ${CLICKHOUSE_PRIVILEGES[access]} ON ${chIdent(d)}.* TO ${checkName(name)};`);
  const head = ["set -e", "(set -o pipefail) 2>/dev/null && set -o pipefail"];
  return {
    list: () =>
      [
        ...head,
        `${client} -q ${sh("SELECT concat('SERVE_DB', char(9), name) FROM system.databases UNION ALL SELECT concat('SERVE_USER', char(9), name) FROM system.users FORMAT TSVRaw")}`,
      ].join("\n"),
    create: (name, password, access, databases) =>
      [...head, run([`CREATE USER ${checkName(name)} IDENTIFIED WITH sha256_password BY ${chLiteral(password)};`, ...grants(name, access, databases)].join("\n"))].join("\n"),
    setPassword: (name, password) => [...head, run(`ALTER USER ${checkName(name)} IDENTIFIED WITH sha256_password BY ${chLiteral(password)};`)].join("\n"),
    setAccess: (name, access, databases) => [...head, run([`REVOKE ALL ON *.* FROM ${checkName(name)};`, ...grants(name, access, databases)].join("\n"))].join("\n"),
    remove: (name) => [...head, run(`DROP USER IF EXISTS ${checkName(name)};`)].join("\n"),
  };
}

/** The scripts that list and change the logins inside a database container of this engine. */
export function userScripts(engine: string, main: EngineCreds): UserScripts {
  switch (engine) {
    case "postgres":
      return postgresScripts(main);
    case "mysql":
      return mysqlScripts("mysql", main);
    case "mariadb":
      return mysqlScripts("mariadb", main);
    case "mongodb":
      return mongoScripts(main);
    case "clickhouse":
      return clickhouseScripts(main);
    default:
      throw new Error("Users are available for PostgreSQL, MySQL, MariaDB, MongoDB and ClickHouse.");
  }
}
