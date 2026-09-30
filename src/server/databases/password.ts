import type { DatabaseConfig } from "@/server/services/types";
import type { EngineCreds } from "./engines";

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Characters Serve accepts in database passwords: safe in URLs, shells and SQL. */
export const PASSWORD_PATTERN = /^[A-Za-z0-9_.~-]{12,128}$/;

/**
 * Shell command, run inside the database container with the current password,
 * that changes the password. Null when the engine reads it from the environment
 * on every start (a restart is enough).
 */
export function changePasswordCommand(cfg: DatabaseConfig, current: EngineCreds, next: string): string | null {
  const user = cfg.username;
  switch (cfg.engine) {
    case "postgres":
      return `PGPASSWORD=${sh(current.password)} psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U ${sh(user)} -d ${sh(cfg.database)} -c ${sh(`ALTER USER "${user.replace(/"/g, '""')}" WITH PASSWORD ${sqlString(next)}`)}`;
    case "mysql":
    case "mariadb": {
      const bin = cfg.engine === "mariadb" ? "mariadb" : "mysql";
      // Root and the app user share the password Serve generated.
      const statements = [
        `ALTER USER IF EXISTS 'root'@'%' IDENTIFIED BY ${sqlString(next)}`,
        `ALTER USER IF EXISTS 'root'@'localhost' IDENTIFIED BY ${sqlString(next)}`,
        ...(user !== "root" ? [`ALTER USER IF EXISTS ${sqlString(user)}@'%' IDENTIFIED BY ${sqlString(next)}`] : []),
        "FLUSH PRIVILEGES",
      ].join("; ");
      return `MYSQL_PWD=${sh(current.password)} ${bin} -uroot -e ${sh(statements)}`;
    }
    case "mongodb":
      return `mongosh --quiet${current.tlsRequired ? " --tls --tlsAllowInvalidCertificates" : ""} -u ${sh(user)} -p ${sh(current.password)} --authenticationDatabase admin admin --eval ${sh(`db.changeUserPassword(${JSON.stringify(user)}, ${JSON.stringify(next)})`)}`;
    case "redis":
    case "valkey": {
      const cli = cfg.engine === "valkey" ? "valkey-cli" : "redis-cli";
      return `${cli} -a ${sh(current.password)} --no-auth-warning${current.tlsRequired ? " --tls --insecure" : ""} CONFIG SET requirepass ${sh(next)} | grep -q OK`;
    }
    case "clickhouse":
      return null;
  }
}
