import type { DbEngine } from "@/server/services/types";

export type EngineInfo = {
  engine: DbEngine;
  label: string;
  image: string;
  versions: string[];
  defaultVersion: string;
  port: number;
  dataPath: string;
  defaultUser: string;
  defaultDatabase: string;
  /** Whether the engine has a configurable user/database. */
  hasUser: boolean;
  hasDatabase: boolean;
  env: (c: EngineCreds) => Record<string, string>;
  command?: (c: EngineCreds) => string[] | undefined;
  healthcheck: (c: EngineCreds) => string[];
  url: (c: EngineCreds & { host: string; port: number }) => string;
  /** Shell command run inside the container that writes a dump to stdout. */
  backupCommand: (c: EngineCreds) => string;
  /** Shell command run inside the container that restores a dump from stdin. */
  restoreCommand: (c: EngineCreds) => string;
  backupExtension: string;

  /** Server process argv when Serve passes arguments (image default otherwise). */
  server?: string[];
  /** User the server runs as inside the container (owns TLS keys). */
  runAs: string;
  /** The image's entrypoint script, used when Serve wraps the start command. */
  entrypoint: string;
  /** Image repositories of the same engine family (for custom images). */
  imagePattern: RegExp;
  /** Runs files in /docker-entrypoint-initdb.d on an empty data directory. */
  initScripts: boolean;
  /** How a custom configuration is applied. */
  config: EngineConfig;
  /** Server arguments that turn on TLS with files in `dir`. Undefined: not supported. */
  tlsArgs?: (dir: string, mode: "prefer" | "require") => string[];
};

export type EngineConfig =
  | { kind: "pg-args"; placeholder: string }
  | { kind: "file"; path: string; args?: (path: string) => string[]; placeholder: string; file: string };

export type EngineCreds = {
  username: string;
  password: string;
  database: string;
  /** TLS is on and required: in-container clients must use it too. */
  tlsRequired?: boolean;
};

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** redis-cli / valkey-cli with auth, over TLS when the server only speaks TLS. */
const rcli = (bin: string, c: EngineCreds) => `${bin} -a ${sh(c.password)} --no-auth-warning${c.tlsRequired ? " --tls --insecure" : ""}`;
const mongoTls = (c: EngineCreds) => (c.tlsRequired ? " --tls --tlsAllowInvalidCertificates" : "");
/** mongodump / mongorestore spell the TLS options differently from mongosh. */
const mongoToolsTls = (c: EngineCreds) => (c.tlsRequired ? " --ssl --sslAllowInvalidCertificates --sslAllowInvalidHostnames" : "");
/** Restores an RDB dump into a server that persists with (multi-part) AOF, then restarts. */
const aofRestore = (cli: string, user: string) =>
  [
    // Stop persisting so the shutdown before the restart cannot overwrite the restored data.
    `${cli} CONFIG SET appendonly no >/dev/null`,
    `${cli} CONFIG SET save "" >/dev/null`,
    "rm -rf /data/appendonlydir.serve && mkdir -p /data/appendonlydir.serve",
    "cat > /data/appendonlydir.serve/appendonly.aof.1.base.rdb",
    "printf 'file appendonly.aof.1.base.rdb seq 1 type b\\n' > /data/appendonlydir.serve/appendonly.aof.manifest",
    "cp /data/appendonlydir.serve/appendonly.aof.1.base.rdb /data/dump.rdb",
    "rm -rf /data/appendonlydir /data/appendonly.aof && mv /data/appendonlydir.serve /data/appendonlydir",
    `chown -R ${user} /data 2>/dev/null; echo "Restored the dump. The database restarts to load it."`,
  ].join(" && ");
const redisTls = (dir: string) => ["--port", "0", "--tls-port", "6379", "--tls-cert-file", `${dir}/server.crt`, "--tls-key-file", `${dir}/server.key`, "--tls-ca-cert-file", `${dir}/ca.crt`, "--tls-auth-clients", "no"];
const mysqlTls = (dir: string, mode: "prefer" | "require") => [`--ssl-ca=${dir}/ca.crt`, `--ssl-cert=${dir}/server.crt`, `--ssl-key=${dir}/server.key`, ...(mode === "require" ? ["--require-secure-transport=ON"] : [])];

export const engines: Record<DbEngine, EngineInfo> = {
  postgres: {
    engine: "postgres",
    label: "PostgreSQL",
    image: "postgres",
    versions: ["18-alpine", "17-alpine", "16-alpine", "15-alpine"],
    defaultVersion: "17-alpine",
    port: 5432,
    dataPath: "/var/lib/postgresql/data",
    defaultUser: "postgres",
    defaultDatabase: "app",
    hasUser: true,
    hasDatabase: true,
    env: (c) => ({
      POSTGRES_USER: c.username,
      POSTGRES_PASSWORD: c.password,
      POSTGRES_DB: c.database,
      PGDATA: "/var/lib/postgresql/data/pgdata",
    }),
    healthcheck: (c) => ["CMD-SHELL", `pg_isready -U ${c.username} -d ${c.database}`],
    url: (c) =>
      `postgresql://${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${c.database}`,
    backupCommand: (c) => `PGPASSWORD=${sh(c.password)} pg_dump -U ${sh(c.username)} -d ${sh(c.database)} -Fc`,
    restoreCommand: (c) =>
      `PGPASSWORD=${sh(c.password)} pg_restore -U ${sh(c.username)} -d ${sh(c.database)} --clean --if-exists --no-owner`,
    backupExtension: "dump",
    server: ["postgres"],
    runAs: "postgres",
    entrypoint: "docker-entrypoint.sh",
    imagePattern: /(^|\/)(postgres|postgis|pgvector|timescaledb[\w-]*|paradedb|pgvecto-rs|supabase-postgres|postgresql)(:|$)/i,
    initScripts: true,
    config: { kind: "pg-args", placeholder: "max_connections = 200\nshared_buffers = 256MB\nwork_mem = 16MB\nlog_min_duration_statement = 500" },
    tlsArgs: (dir) => ["-c", "ssl=on", "-c", `ssl_cert_file=${dir}/server.crt`, "-c", `ssl_key_file=${dir}/server.key`, "-c", `ssl_ca_file=${dir}/ca.crt`],
  },
  mysql: {
    engine: "mysql",
    label: "MySQL",
    image: "mysql",
    versions: ["9", "8.4", "8.0"],
    defaultVersion: "8.4",
    port: 3306,
    dataPath: "/var/lib/mysql",
    defaultUser: "app",
    defaultDatabase: "app",
    hasUser: true,
    hasDatabase: true,
    env: (c) => ({
      MYSQL_ROOT_PASSWORD: c.password,
      MYSQL_DATABASE: c.database,
      ...(c.username !== "root" ? { MYSQL_USER: c.username, MYSQL_PASSWORD: c.password } : {}),
    }),
    healthcheck: (c) => ["CMD-SHELL", `mysqladmin ping -h 127.0.0.1 -uroot -p${c.password} --silent`],
    url: (c) =>
      `mysql://${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${c.database}`,
    backupCommand: (c) =>
      `mysqldump -uroot -p${sh(c.password)} --single-transaction --routines --triggers --databases ${sh(c.database)}`,
    restoreCommand: (c) => `mysql -uroot -p${sh(c.password)}`,
    backupExtension: "sql",
    server: ["mysqld"],
    runAs: "mysql",
    entrypoint: "docker-entrypoint.sh",
    imagePattern: /(^|\/)(mysql|mysql-server|percona|percona-server)(:|$)/i,
    initScripts: true,
    config: { kind: "file", path: "/etc/mysql/conf.d/serve.cnf", file: "my.cnf", placeholder: "[mysqld]\nmax_connections = 300\ninnodb_buffer_pool_size = 512M\nslow_query_log = 1" },
    tlsArgs: mysqlTls,
  },
  mariadb: {
    engine: "mariadb",
    label: "MariaDB",
    image: "mariadb",
    versions: ["11", "10.11"],
    defaultVersion: "11",
    port: 3306,
    dataPath: "/var/lib/mysql",
    defaultUser: "app",
    defaultDatabase: "app",
    hasUser: true,
    hasDatabase: true,
    env: (c) => ({
      MARIADB_ROOT_PASSWORD: c.password,
      MARIADB_DATABASE: c.database,
      ...(c.username !== "root" ? { MARIADB_USER: c.username, MARIADB_PASSWORD: c.password } : {}),
    }),
    healthcheck: () => ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"],
    url: (c) =>
      `mysql://${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${c.database}`,
    backupCommand: (c) =>
      `mariadb-dump -uroot -p${sh(c.password)} --single-transaction --routines --triggers --databases ${sh(c.database)}`,
    restoreCommand: (c) => `mariadb -uroot -p${sh(c.password)}`,
    backupExtension: "sql",
    server: ["mariadbd"],
    runAs: "mysql",
    entrypoint: "docker-entrypoint.sh",
    imagePattern: /(^|\/)mariadb(:|$)/i,
    initScripts: true,
    config: { kind: "file", path: "/etc/mysql/conf.d/serve.cnf", file: "my.cnf", placeholder: "[mariadbd]\nmax_connections = 300\ninnodb_buffer_pool_size = 512M" },
    tlsArgs: mysqlTls,
  },
  mongodb: {
    engine: "mongodb",
    label: "MongoDB",
    image: "mongo",
    versions: ["8", "7"],
    defaultVersion: "8",
    port: 27017,
    dataPath: "/data/db",
    defaultUser: "root",
    defaultDatabase: "app",
    hasUser: true,
    hasDatabase: true,
    env: (c) => ({
      MONGO_INITDB_ROOT_USERNAME: c.username,
      MONGO_INITDB_ROOT_PASSWORD: c.password,
      MONGO_INITDB_DATABASE: c.database,
    }),
    healthcheck: (c) => ["CMD-SHELL", `mongosh --quiet${mongoTls(c)} --eval "db.adminCommand('ping').ok" | grep -q 1`],
    url: (c) =>
      `mongodb://${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${c.database}?authSource=admin`,
    backupCommand: (c) =>
      `mongodump --quiet${mongoToolsTls(c)} --archive --gzip -u ${sh(c.username)} -p ${sh(c.password)} --authenticationDatabase admin`,
    restoreCommand: (c) =>
      `mongorestore --quiet${mongoToolsTls(c)} --archive --gzip --drop -u ${sh(c.username)} -p ${sh(c.password)} --authenticationDatabase admin`,
    backupExtension: "archive.gz",
    server: ["mongod"],
    runAs: "mongodb",
    entrypoint: "docker-entrypoint.sh",
    imagePattern: /(^|\/)(mongo|mongodb-community-server|percona-server-mongodb)(:|$)/i,
    initScripts: true,
    config: { kind: "file", path: "/etc/serve/mongod.conf", file: "mongod.conf", args: (p) => ["--config", p], placeholder: "operationProfiling:\n  slowOpThresholdMs: 200\nstorage:\n  wiredTiger:\n    engineConfig:\n      cacheSizeGB: 1" },
    tlsArgs: (dir, mode) => ["--tlsMode", mode === "require" ? "requireTLS" : "preferTLS", "--tlsCertificateKeyFile", `${dir}/server.pem`, "--tlsCAFile", `${dir}/ca.crt`, "--tlsAllowConnectionsWithoutCertificates"],
  },
  redis: {
    engine: "redis",
    label: "Redis",
    image: "redis",
    versions: ["8-alpine", "7-alpine"],
    defaultVersion: "8-alpine",
    port: 6379,
    dataPath: "/data",
    defaultUser: "default",
    defaultDatabase: "0",
    hasUser: false,
    hasDatabase: false,
    env: () => ({}),
    command: (c) => ["redis-server", "--requirepass", c.password, "--appendonly", "yes"],
    healthcheck: (c) => ["CMD-SHELL", `${rcli("redis-cli", c)} ping | grep -q PONG`],
    url: (c) => `redis://default:${encodeURIComponent(c.password)}@${c.host}:${c.port}`,
    backupCommand: (c) =>
      `${rcli("redis-cli", c)} --rdb /tmp/serve-backup.rdb >/dev/null && cat /tmp/serve-backup.rdb && rm -f /tmp/serve-backup.rdb`,
    // With appendonly on, startup loads the AOF only: install the dump as the AOF base file.
    restoreCommand: (c) => aofRestore(rcli("redis-cli", c), "redis"),
    backupExtension: "rdb",
    runAs: "redis",
    entrypoint: "docker-entrypoint.sh",
    imagePattern: /(^|\/)(redis|redis-stack-server|keydb)(:|$)/i,
    initScripts: false,
    config: { kind: "file", path: "/etc/serve/redis.conf", file: "redis.conf", placeholder: "maxmemory 256mb\nmaxmemory-policy allkeys-lru\nsave 900 1" },
    tlsArgs: redisTls,
  },
  valkey: {
    engine: "valkey",
    label: "Valkey",
    image: "valkey/valkey",
    versions: ["8-alpine"],
    defaultVersion: "8-alpine",
    port: 6379,
    dataPath: "/data",
    defaultUser: "default",
    defaultDatabase: "0",
    hasUser: false,
    hasDatabase: false,
    env: () => ({}),
    command: (c) => ["valkey-server", "--requirepass", c.password, "--appendonly", "yes"],
    healthcheck: (c) => ["CMD-SHELL", `${rcli("valkey-cli", c)} ping | grep -q PONG`],
    url: (c) => `redis://default:${encodeURIComponent(c.password)}@${c.host}:${c.port}`,
    backupCommand: (c) =>
      `${rcli("valkey-cli", c)} --rdb /tmp/serve-backup.rdb >/dev/null && cat /tmp/serve-backup.rdb && rm -f /tmp/serve-backup.rdb`,
    // With appendonly on, startup loads the AOF only: install the dump as the AOF base file.
    restoreCommand: (c) => aofRestore(rcli("valkey-cli", c), "valkey"),
    backupExtension: "rdb",
    runAs: "valkey",
    entrypoint: "docker-entrypoint.sh",
    imagePattern: /(^|\/)valkey(:|$)/i,
    initScripts: false,
    config: { kind: "file", path: "/etc/serve/valkey.conf", file: "valkey.conf", placeholder: "maxmemory 256mb\nmaxmemory-policy allkeys-lru\nsave 900 1" },
    tlsArgs: redisTls,
  },
  clickhouse: {
    engine: "clickhouse",
    label: "ClickHouse",
    image: "clickhouse/clickhouse-server",
    versions: ["25.8-alpine", "latest"],
    defaultVersion: "25.8-alpine",
    port: 8123,
    dataPath: "/var/lib/clickhouse",
    defaultUser: "default",
    defaultDatabase: "default",
    hasUser: true,
    hasDatabase: true,
    env: (c) => ({
      CLICKHOUSE_USER: c.username,
      CLICKHOUSE_PASSWORD: c.password,
      CLICKHOUSE_DB: c.database,
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1",
    }),
    healthcheck: () => ["CMD-SHELL", "wget -qO- http://127.0.0.1:8123/ping | grep -q Ok"],
    url: (c) =>
      `clickhouse://${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${c.database}`,
    backupCommand: (c) =>
      `for t in $(clickhouse-client -u ${sh(c.username)} --password ${sh(c.password)} -d ${sh(c.database)} -q 'SHOW TABLES'); do echo "-- TABLE $t"; clickhouse-client -u ${sh(c.username)} --password ${sh(c.password)} -d ${sh(c.database)} -q "SHOW CREATE TABLE $t FORMAT TSVRaw"; echo ";"; done`,
    restoreCommand: (c) =>
      `clickhouse-client -u ${sh(c.username)} --password ${sh(c.password)} -d ${sh(c.database)} --multiquery`,
    backupExtension: "sql",
    runAs: "clickhouse",
    entrypoint: "/entrypoint.sh",
    imagePattern: /(^|\/)clickhouse-server(:|$)/i,
    initScripts: true,
    config: { kind: "file", path: "/etc/clickhouse-server/config.d/serve.xml", file: "serve.xml", placeholder: "<clickhouse>\n  <max_concurrent_queries>200</max_concurrent_queries>\n</clickhouse>" },
  },
};

export const engineList = Object.values(engines);

export function engineImage(engine: DbEngine, version: string, override?: string | null) {
  return override?.trim() || `${engines[engine].image}:${version}`;
}
