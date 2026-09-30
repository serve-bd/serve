import YAML from "yaml";
import type { DatabaseConfig } from "@/server/services/types";

type Engine = DatabaseConfig["engine"];

/** Engine of a database image, from the last part of its name: postgres, bitnami/postgresql, pgvector/pgvector, … */
export function engineOfImage(image: string): Engine | null {
  const name = image
    .toLowerCase()
    .split("@")[0]
    .replace(/:[^/]*$/, "");
  const last = name.split("/").at(-1) ?? "";
  if (/^(postgres|postgresql|postgis|pgvector|timescaledb(-ha)?|supabase-postgres)$/.test(last) || /(^|-)postgres(ql)?($|-)/.test(last)) return "postgres";
  if (/^mariadb$/.test(last)) return "mariadb";
  if (/^(mysql|mysql-server|percona-server)$/.test(last)) return "mysql";
  if (/^(mongo|mongodb|mongodb-community-server)$/.test(last)) return "mongodb";
  if (/^valkey$/.test(last)) return "valkey";
  if (/^(redis|redis-stack-server|redis-stack)$/.test(last)) return "redis";
  return null;
}

export type ComposeDatabase = { service: string; engine: Engine; image: string };

/** Database containers of a compose file, found by their images. */
export function composeDatabases(content: string): ComposeDatabase[] {
  let data: { services?: Record<string, { image?: unknown } | null> } | null = null;
  try {
    data = YAML.parse(content, { merge: true });
  } catch {
    return [];
  }
  const out: ComposeDatabase[] = [];
  for (const [service, def] of Object.entries(data?.services ?? {})) {
    const image = typeof def?.image === "string" ? def.image : "";
    const engine = image ? engineOfImage(image) : null;
    if (engine) out.push({ service, engine, image });
  }
  return out;
}

/** Login for a dump, read from the container's environment (what its image uses on first start). */
export type ComposeCreds = { username: string; password: string; database: string; root: boolean };

/**
 * Credentials from a database container's environment. `*_FILE` variables are resolved by the
 * caller (`files` holds their contents). Returns a message when the environment is not enough.
 */
export function credsFromEnv(engine: Engine, env: Record<string, string>, files: Record<string, string> = {}): ComposeCreds | string {
  const get = (...keys: string[]) => {
    for (const k of keys) {
      if (env[k]) return env[k];
      if (files[`${k}_FILE`] !== undefined) return files[`${k}_FILE`].trim();
    }
    return "";
  };
  switch (engine) {
    case "postgres": {
      const username = get("POSTGRES_USER", "POSTGRESQL_USERNAME", "POSTGRESQL_USER") || "postgres";
      const password = get("POSTGRES_PASSWORD", "POSTGRESQL_PASSWORD");
      return { username, password, database: get("POSTGRES_DB", "POSTGRESQL_DATABASE") || username, root: username === "postgres" };
    }
    case "mysql":
    case "mariadb": {
      const p = engine === "mariadb" ? "MARIADB_" : "MYSQL_";
      const rootPassword = get(`${p}ROOT_PASSWORD`, "MYSQL_ROOT_PASSWORD");
      const database = get(`${p}DATABASE`, "MYSQL_DATABASE");
      if (!database) return `Set ${p}DATABASE on this container so Serve knows which database to back up.`;
      if (rootPassword) return { username: "root", password: rootPassword, database, root: true };
      const username = get(`${p}USER`, "MYSQL_USER");
      const password = get(`${p}PASSWORD`, "MYSQL_PASSWORD");
      if (!username) return `Set ${p}ROOT_PASSWORD or ${p}USER and ${p}PASSWORD on this container.`;
      return { username, password, database, root: false };
    }
    case "mongodb": {
      const username = get("MONGO_INITDB_ROOT_USERNAME", "MONGODB_ROOT_USER");
      return { username, password: get("MONGO_INITDB_ROOT_PASSWORD", "MONGODB_ROOT_PASSWORD"), database: get("MONGO_INITDB_DATABASE"), root: true };
    }
    case "redis":
    case "valkey":
      return { username: "", password: get("REDIS_PASSWORD", "VALKEY_PASSWORD"), database: "", root: true };
    case "clickhouse":
      return "ClickHouse inside a compose stack is not backed up yet.";
  }
}

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** File extension of a dump, per engine. */
export const DUMP_EXTENSION: Record<Engine, string> = {
  postgres: "dump",
  mysql: "sql",
  mariadb: "sql",
  mongodb: "archive.gz",
  redis: "rdb",
  valkey: "rdb",
  clickhouse: "sql",
};

/**
 * Commands that run inside the database container: the dump writes to stdout, the restore
 * reads from stdin. They connect locally, the way the image's own tools expect.
 */
export function dumpCommands(engine: Engine, c: ComposeCreds): { backup: string; restore: string; restorePlain?: string } {
  switch (engine) {
    case "postgres": {
      const auth = `${c.password ? `PGPASSWORD=${sh(c.password)} ` : ""}`;
      return {
        backup: `${auth}pg_dump -U ${sh(c.username)} -d ${sh(c.database)} -Fc`,
        restore: `${auth}pg_restore -U ${sh(c.username)} -d ${sh(c.database)} --clean --if-exists --no-owner`,
        restorePlain: `${auth}psql -X -v ON_ERROR_STOP=1 -q -U ${sh(c.username)} -d ${sh(c.database)}`,
      };
    }
    case "mysql":
    case "mariadb": {
      const dump = engine === "mariadb" ? "$(command -v mariadb-dump || command -v mysqldump)" : "mysqldump";
      const cli = engine === "mariadb" ? "$(command -v mariadb || command -v mysql)" : "mysql";
      const auth = `-u${sh(c.username)}${c.password ? ` -p${sh(c.password)}` : ""}`;
      return {
        backup: `${dump} ${auth} --single-transaction --routines --triggers${c.root ? "" : " --no-tablespaces"} --databases ${sh(c.database)}`,
        restore: `${cli} ${auth}`,
      };
    }
    case "mongodb": {
      const auth = c.username ? ` -u ${sh(c.username)} -p ${sh(c.password)} --authenticationDatabase admin` : "";
      return { backup: `mongodump --quiet --archive --gzip${auth}`, restore: `mongorestore --quiet --archive --gzip --drop${auth}` };
    }
    case "redis":
    case "valkey": {
      const bin = engine === "valkey" ? "valkey-cli" : "redis-cli";
      const cli = `${bin}${c.password ? ` -a ${sh(c.password)} --no-auth-warning` : ""}`;
      return {
        backup: `${cli} --rdb /tmp/serve-backup.rdb >/dev/null && cat /tmp/serve-backup.rdb && rm -f /tmp/serve-backup.rdb`,
        // Persistence stops first, so the shutdown before the restart cannot overwrite the restored
        // data; the dump becomes both the RDB file and the base of a fresh append-only file.
        restore: [
          `d=$(${cli} CONFIG GET dir | tail -n1) && f=$(${cli} CONFIG GET dbfilename | tail -n1)`,
          `${cli} CONFIG SET appendonly no >/dev/null`,
          `${cli} CONFIG SET save "" >/dev/null`,
          `rm -rf "$d/appendonlydir.serve" && mkdir -p "$d/appendonlydir.serve"`,
          `cat > "$d/appendonlydir.serve/appendonly.aof.1.base.rdb"`,
          `printf 'file appendonly.aof.1.base.rdb seq 1 type b\\n' > "$d/appendonlydir.serve/appendonly.aof.manifest"`,
          `cp "$d/appendonlydir.serve/appendonly.aof.1.base.rdb" "$d/$f"`,
          `rm -rf "$d/appendonlydir" "$d/appendonly.aof" && mv "$d/appendonlydir.serve" "$d/appendonlydir"`,
          `echo "Restored the dump. The container restarts to load it."`,
        ].join(" && "),
      };
    }
    case "clickhouse":
      throw new Error("ClickHouse inside a compose stack is not backed up yet.");
  }
}

/** The --requirepass value from a redis-server command line (split or in one shell string). */
export function requirePass(args: string[]) {
  const words = args.flatMap((a) => a.split(/\s+/)).filter(Boolean);
  for (const [i, w] of words.entries()) {
    if (w === "--requirepass") return (words[i + 1] ?? "").replace(/^["']|["']$/g, "");
    if (w.startsWith("--requirepass=")) return w.slice("--requirepass=".length).replace(/^["']|["']$/g, "");
  }
  return "";
}

/** Splits a compose backup key: db:postgres, volume:app_data, dir:/srv/media. */
export function parseBackupKey(key: string): { kind: "db" | "volume" | "dir"; name: string } | null {
  const m = /^(db|volume|dir):(.+)$/.exec(key);
  return m ? { kind: m[1] as "db" | "volume" | "dir", name: m[2] } : null;
}
