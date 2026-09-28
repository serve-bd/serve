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
};

export type EngineCreds = { username: string; password: string; database: string };

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

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
    healthcheck: () => ["CMD-SHELL", `mongosh --quiet --eval "db.adminCommand('ping').ok" | grep -q 1`],
    url: (c) =>
      `mongodb://${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${c.database}?authSource=admin`,
    backupCommand: (c) =>
      `mongodump --quiet --archive --gzip -u ${sh(c.username)} -p ${sh(c.password)} --authenticationDatabase admin`,
    restoreCommand: (c) =>
      `mongorestore --quiet --archive --gzip --drop -u ${sh(c.username)} -p ${sh(c.password)} --authenticationDatabase admin`,
    backupExtension: "archive.gz",
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
    healthcheck: (c) => ["CMD-SHELL", `redis-cli -a ${sh(c.password)} --no-auth-warning ping | grep -q PONG`],
    url: (c) => `redis://default:${encodeURIComponent(c.password)}@${c.host}:${c.port}`,
    backupCommand: (c) =>
      `redis-cli -a ${sh(c.password)} --no-auth-warning --rdb /tmp/serve-backup.rdb >/dev/null && cat /tmp/serve-backup.rdb && rm -f /tmp/serve-backup.rdb`,
    restoreCommand: () =>
      `cat > /data/dump.rdb && echo "Restored dump.rdb. The database restarts to load it."`,
    backupExtension: "rdb",
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
    healthcheck: (c) => ["CMD-SHELL", `valkey-cli -a ${sh(c.password)} --no-auth-warning ping | grep -q PONG`],
    url: (c) => `redis://default:${encodeURIComponent(c.password)}@${c.host}:${c.port}`,
    backupCommand: (c) =>
      `valkey-cli -a ${sh(c.password)} --no-auth-warning --rdb /tmp/serve-backup.rdb >/dev/null && cat /tmp/serve-backup.rdb && rm -f /tmp/serve-backup.rdb`,
    restoreCommand: () =>
      `cat > /data/dump.rdb && echo "Restored dump.rdb. The database restarts to load it."`,
    backupExtension: "rdb",
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
  },
};

export const engineList = Object.values(engines);

export function engineImage(engine: DbEngine, version: string) {
  return `${engines[engine].image}:${version}`;
}
