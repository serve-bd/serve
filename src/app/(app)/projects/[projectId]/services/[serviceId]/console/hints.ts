/** Commands offered under a console, by database engine; apps get general ones. */
const HINTS: Record<string, string[]> = {
  postgres: ["psql", "psql -c '\\dt'", "pg_isready"],
  mysql: ["mysql -uroot", "mysql -uroot -e 'show databases'"],
  mariadb: ["mariadb -uroot", "mariadb -uroot -e 'show databases'"],
  redis: ["redis-cli", "redis-cli info memory"],
  valkey: ["valkey-cli", "valkey-cli info memory"],
  mongodb: ["mongosh -u $MONGO_INITDB_ROOT_USERNAME -p $MONGO_INITDB_ROOT_PASSWORD"],
  clickhouse: ["clickhouse-client"],
};

export const consoleHints = (engine: string | null | undefined) => (engine ? (HINTS[engine] ?? []) : ["ls -la", "env | sort", "df -h", "top"]);
