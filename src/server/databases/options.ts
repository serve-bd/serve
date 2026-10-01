import path from "node:path";
import type { DatabaseConfig } from "@/server/services/types";
import { engineImage, engines, type EngineCreds, type EngineInfo } from "./engines";

/** Where TLS files are mounted (read-only) and where the start script copies them for the server user. */
export const TLS_SOURCE = "/etc/serve-tls";
export const TLS_DIR = "/run/serve-tls";

/** The certificate of a database's domain (one clients trust): read-only binds of its files, and their paths in the container. */
export type DomainCert = { binds: string[]; cert: string; key: string };

export type HealthTiming = { interval: number; timeout: number; retries: number; startPeriod: number };

export const DEFAULT_HEALTH: HealthTiming = { interval: 5, timeout: 5, retries: 10, startPeriod: 10 };

export type DatabasePlan = {
  image: string;
  env: Record<string, string>;
  cmd?: string[];
  /** host:container[:ro] binds for files Serve generates (config, init scripts, TLS). */
  binds: string[];
  /** Files Serve writes on the server before starting the container. */
  files: { path: string; content: string; mode?: number }[];
  /** Directories cleared before the files are written (so deleted init scripts disappear). */
  resetDirs: string[];
  dataMountPath: string;
  healthcheck: string[];
  health: HealthTiming;
  creds: EngineCreds;
  tls: boolean;
  /** Container port the public port leads to: the TLS port when TLS is on. */
  publicTarget: number;
  /** TLS uses the domain's certificate, which clients can verify. */
  verified: boolean;
};

/** Splits a command line into arguments, honoring single and double quotes. */
export function splitArgs(input: string | null | undefined): string[] {
  if (!input?.trim()) return [];
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else if (ch === "\\" && i + 1 < input.length) {
      cur += input[++i];
    } else cur += ch;
  }
  if (quote) throw new Error("An argument has an unclosed quote.");
  if (cur || has) out.push(cur);
  return out;
}

/** postgresql.conf style lines ("key = value", comments allowed) as -c arguments. */
export function pgConfigArgs(config: string | null | undefined): string[] {
  const args: string[] = [];
  for (const [i, raw] of (config ?? "").split("\n").entries()) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([a-z_][a-z0-9_.]*)\s*(?:=\s*|\s+)(.+)$/i);
    if (!m) throw new Error(`Line ${i + 1} is not "setting = value".`);
    const value = m[2].trim().replace(/^'(.*)'$/, "$1");
    args.push("-c", `${m[1]}=${value}`);
  }
  return args;
}

const SCRIPT_NAME = /^[\w][\w.-]{0,80}\.(sql|sql\.gz|sh|js)$/;

/** Checks a database configuration. Returns human readable problems (empty when valid). */
export function databaseConfigIssues(cfg: DatabaseConfig): string[] {
  const engine = engines[cfg.engine];
  const issues: string[] = [];
  if (cfg.image) {
    if (!/^[a-z0-9]([\w.\-/:@]*[\w])?$/i.test(cfg.image) || cfg.image.length > 255) issues.push("The image is not a valid image reference.");
    else {
      const repo = cfg.image.replace(/@.*$/, "").replace(/:[^/]*$/, "");
      if (!engine.imagePattern.test(`${repo}:`)) issues.push(`${cfg.image} does not look like a ${engine.label} image.`);
    }
  }
  if (engine.config.kind === "pg-args") {
    try {
      pgConfigArgs(cfg.customConfig);
    } catch (e) {
      issues.push(`Custom configuration: ${(e as Error).message}`);
    }
  }
  if (cfg.customConfig && cfg.customConfig.length > 64_000) issues.push("The custom configuration is too long.");
  try {
    splitArgs(cfg.extraArgs);
  } catch (e) {
    issues.push(`Extra arguments: ${(e as Error).message}`);
  }
  if (cfg.initScripts?.length && !engine.initScripts) issues.push(`${engine.label} does not run initialization scripts.`);
  const names = new Set<string>();
  for (const s of cfg.initScripts ?? []) {
    if (!SCRIPT_NAME.test(s.name)) issues.push(`Script name ${s.name || "(empty)"} must end in .sql, .sh or .js and use letters, numbers, dots and dashes.`);
    if (names.has(s.name)) issues.push(`Script ${s.name} is listed twice.`);
    names.add(s.name);
    if (s.content.length > 512_000) issues.push(`Script ${s.name} is larger than 500 KB.`);
  }
  if (cfg.charset && !/^[a-z0-9_]{1,32}$/i.test(cfg.charset)) issues.push("The character set is not valid.");
  if (cfg.collation && !/^[a-z0-9_]{1,64}$/i.test(cfg.collation)) issues.push("The collation is not valid.");
  if (cfg.initdbArgs && /[\n\r]/.test(cfg.initdbArgs)) issues.push("Initdb arguments must be on one line.");
  if (cfg.dataMountPath && !/^\/[\w./-]*$/.test(cfg.dataMountPath)) issues.push("The data mount path must be absolute.");
  if (
    cfg.dataMountPath &&
    (cfg.dataMountPath === "/" || [TLS_SOURCE, TLS_DIR, "/docker-entrypoint-initdb.d", "/etc/serve"].some((p) => cfg.dataMountPath!.replace(/\/+$/, "").startsWith(p)))
  )
    issues.push("The data mount path cannot be / or a directory Serve uses.");
  if (cfg.tls?.enabled && !engine.tlsArgs) issues.push(`Serve cannot turn on TLS for ${engine.label}.`);
  if (cfg.tls?.enabled && cfg.tls.mode === "require" && cfg.engine === "clickhouse")
    issues.push("ClickHouse keeps plain ports for the private network: TLS can be optional, not required.");
  return issues;
}

function mysqlConfig(content: string, engine: EngineInfo) {
  const trimmed = content.trim();
  if (!trimmed) return "";
  return /^\s*\[/m.test(trimmed.split("\n").find((l) => l.trim() && !l.trim().startsWith("#")) ?? "")
    ? `${trimmed}\n`
    : `[${engine.engine === "mariadb" ? "mariadbd" : "mysqld"}]\n${trimmed}\n`;
}

/**
 * Everything needed to run a database container from its configuration: image,
 * environment, command, generated files and health check. Pure, so it is unit tested.
 */
/** Credentials for commands run inside the container (backups, restores, health checks). */
export function databaseCreds(cfg: DatabaseConfig, password: string): EngineCreds {
  const tls = !!(cfg.tls?.enabled && engines[cfg.engine].tlsArgs);
  const mode = cfg.tls?.mode ?? "prefer";
  return {
    username: cfg.username,
    password,
    database: cfg.database,
    tlsRequired: tls && (cfg.engine === "redis" || cfg.engine === "valkey" || (cfg.engine === "mongodb" && mode === "require")),
  };
}

export function databasePlan(cfg: DatabaseConfig, password: string, serviceDir: string, domainCert?: DomainCert | null): DatabasePlan {
  const engine = engines[cfg.engine];
  const tls = !!(cfg.tls?.enabled && engine.tlsArgs);
  const mode = cfg.tls?.mode ?? "prefer";
  const creds = databaseCreds(cfg, password);
  const env = engine.env(creds);
  if (cfg.engine === "postgres") {
    if (cfg.initdbArgs?.trim()) env.POSTGRES_INITDB_ARGS = cfg.initdbArgs.trim();
    if (cfg.hostAuthMethod) env.POSTGRES_HOST_AUTH_METHOD = cfg.hostAuthMethod;
  }

  const binds: string[] = [];
  const files: DatabasePlan["files"] = [];
  const resetDirs: string[] = [];
  const args: string[] = [];
  let configFile: string | null = null;

  const custom = cfg.customConfig?.trim() ?? "";
  if (custom) {
    if (engine.config.kind === "pg-args") args.push(...pgConfigArgs(custom));
    else {
      const host = path.posix.join(serviceDir, "config", engine.config.file);
      const content = cfg.engine === "mysql" || cfg.engine === "mariadb" ? mysqlConfig(custom, engine) : `${custom}\n`;
      files.push({ path: host, content, mode: 0o644 });
      binds.push(`${host}:${engine.config.path}:ro`);
      configFile = engine.config.path;
      args.push(...(engine.config.args?.(engine.config.path) ?? []));
    }
  }
  if ((cfg.engine === "mysql" || cfg.engine === "mariadb") && cfg.charset) args.push(`--character-set-server=${cfg.charset}`);
  if ((cfg.engine === "mysql" || cfg.engine === "mariadb") && cfg.collation) args.push(`--collation-server=${cfg.collation}`);
  if (tls) {
    binds.push(`${path.posix.join(serviceDir, "tls")}:${TLS_SOURCE}:ro`);
    if (domainCert) binds.push(...domainCert.binds);
    args.push(...engine.tlsArgs!(TLS_DIR, mode));
    const file = engine.tlsFile?.(TLS_DIR);
    if (file) {
      const host = path.posix.join(serviceDir, "config", file.file);
      files.push({ path: host, content: file.content, mode: 0o644 });
      binds.push(`${host}:${file.path}:ro`);
    }
  }
  args.push(...splitArgs(cfg.extraArgs));

  if (engine.initScripts) {
    const dir = path.posix.join(serviceDir, "initdb");
    resetDirs.push(dir);
    const scripts = cfg.initScripts ?? [];
    for (const s of scripts) files.push({ path: path.posix.join(dir, s.name), content: s.content, mode: s.name.endsWith(".sh") ? 0o755 : 0o644 });
    if (scripts.length) binds.push(`${dir}:/docker-entrypoint-initdb.d:ro`);
  }

  let cmd: string[] | undefined;
  const base = engine.command?.(creds);
  if (base) {
    // redis-server takes the config file as its first argument; flags after it win.
    cmd = [base[0], ...(configFile ? [configFile] : []), ...base.slice(1), ...args];
  } else if (args.length && engine.server) {
    cmd = [...engine.server, ...args];
  }
  // Engines started by their image's default command (ClickHouse) still need the TLS copy step.
  if (tls && !cmd && engine.tlsFile) cmd = [];
  if (tls && cmd) {
    // Keys must belong to the server user; bind mounts keep the host owner, so copy them first.
    // With a domain, its certificate replaces the one from Serve's authority (which stays trusted
    // for clients that pinned it); it is copied at every start, so a restart loads a renewal.
    const domain = domainCert
      ? ` && cp -L ${domainCert.cert} ${TLS_DIR}/server.crt && cp -L ${domainCert.key} ${TLS_DIR}/server.key && cat ${TLS_DIR}/server.crt ${TLS_DIR}/server.key > ${TLS_DIR}/server.pem && cat ${TLS_DIR}/server.crt >> ${TLS_DIR}/ca.crt`
      : "";
    const prepare = `mkdir -p ${TLS_DIR} && cp ${TLS_SOURCE}/* ${TLS_DIR}/${domain} && chown -R ${engine.runAs} ${TLS_DIR} && chmod 600 ${TLS_DIR}/server.key ${TLS_DIR}/server.pem && exec ${engine.entrypoint} "$@"`;
    cmd = ["sh", "-c", prepare, "sh", ...cmd];
  }

  const h = cfg.healthcheck ?? {};
  return {
    image: engineImage(cfg.engine, cfg.version, cfg.image),
    env,
    cmd,
    binds,
    files,
    resetDirs,
    dataMountPath: cfg.dataMountPath?.trim() || engine.dataPath,
    healthcheck: engine.healthcheck(creds),
    health: {
      interval: h.interval ?? DEFAULT_HEALTH.interval,
      timeout: h.timeout ?? DEFAULT_HEALTH.timeout,
      retries: h.retries ?? DEFAULT_HEALTH.retries,
      startPeriod: h.startPeriod ?? DEFAULT_HEALTH.startPeriod,
    },
    creds,
    tls,
    publicTarget: tls ? (engine.tlsPort?.(mode) ?? engine.port) : engine.port,
    verified: tls && !!domainCert,
  };
}

/**
 * Connection URL including TLS parameters. `public`: through the public port, which leads to the TLS
 * port when TLS is on. `verified`: the database has a certificate clients trust (its domain's), so they
 * check it; otherwise they encrypt without checking Serve's own certificate authority.
 */
export function databaseUrl(cfg: DatabaseConfig, creds: EngineCreds, host: string, port: number, opts: { public?: boolean; verified?: boolean } = {}) {
  const engine = engines[cfg.engine];
  const url = engine.url({ ...creds, host, port });
  if (!cfg.tls?.enabled || !engine.tlsArgs) return url;
  const mode = cfg.tls.mode ?? "prefer";
  // Redis and Valkey speak TLS only, once it is on.
  const viaTls = !!opts.public || mode === "require" || cfg.engine === "redis" || cfg.engine === "valkey";
  switch (cfg.engine) {
    case "postgres":
      // verify-full would need sslrootcert=system, which older libpq and most drivers read as a file name.
      return `${url}?sslmode=${viaTls ? "require" : "prefer"}`;
    case "mongodb":
      return viaTls ? `${url}&tls=true${opts.verified ? "" : "&tlsAllowInvalidCertificates=true"}` : url;
    case "redis":
    case "valkey":
      return viaTls ? url.replace(/^redis:/, "rediss:") : url;
    case "clickhouse":
      // Only the public port leads to a TLS port; 8123 and 9000 stay plain.
      return opts.public ? `${url}?secure=true` : url;
    default:
      return url;
  }
}
