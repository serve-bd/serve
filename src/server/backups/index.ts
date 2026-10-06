import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { databaseContainer } from "@/server/databases/container";
import { PassThrough, Readable } from "node:stream";
import readline from "node:readline";
import zlib from "node:zlib";
import { decryptFile, ENCRYPTED_SUFFIX, encryptFile, keyHint } from "./encrypt";
import { accountsMergeSql, planSql, type SqlEngine, sqlFilterStream, sqlLineFilter } from "./sql-filter";
import { pipeline } from "node:stream/promises";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type Docker from "dockerode";
import { execExitCode, LABEL } from "@/server/docker/client";
import { credsFromEnv, DUMP_EXTENSION, dumpCommands, engineOfImage, parseBackupKey, requirePass } from "./compose";

export { parseBackupKey };
import { dumpStorage, restoreStorage, stackStorage } from "./storage";
import { db, schema } from "@/server/db";
import { readChoice } from "@/lib/backup-databases";
import { decrypt } from "@/server/crypto";
import { serverOf } from "@/server/servers/context";
import { engines, pgDbname } from "@/server/databases/engines";
import { databaseCreds } from "@/server/databases/options";
import type { DatabaseConfig } from "@/server/services/types";
import { newId } from "@/server/id";
import { paths } from "@/server/paths";
import { notify, orgOfService } from "@/server/notify";
import { s3Delete, s3Download, s3Stream, s3Upload, type S3Config } from "./s3";

export async function s3For(id: string | null | undefined): Promise<(S3Config & { prefix: string; id: string }) | null> {
  if (!id) return null;
  const [row] = await db.select().from(schema.s3Destination).where(eq(schema.s3Destination.id, id));
  if (!row) return null;
  const { getSetting } = await import("@/server/settings");
  return {
    id: row.id,
    // Only the Root organization may keep storage on a private address.
    publicOnly: row.organizationId !== (await getSetting("rootOrganizationId")),
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    accessKeyId: row.accessKeyId,
    secretAccessKey: decrypt(row.secretAccessKey),
    prefix: row.pathPrefix.replace(/^\/+|\/+$/g, ""),
  };
}

const s3Key = (prefix: string, serviceSlug: string, filename: string) => [prefix, serviceSlug, filename].filter(Boolean).join("/");

export function backupFile(serviceId: string, filename: string) {
  return path.join(paths.backups, serviceId, filename);
}

/** Appends a line to a backup's log (shown under the backup in the UI). */
async function logLine(backupId: string, line: string) {
  const stamp = new Date().toISOString().slice(11, 19);
  await db
    .update(schema.backup)
    .set({ log: sql`right(coalesce(${schema.backup.log}, '') || ${`${stamp} ${line}\n`}, 20000)` })
    .where(eq(schema.backup.id, backupId));
}

type ServiceRow = typeof schema.service.$inferSelect;

/** A database container and the commands that dump into and restore from it. */
/**
 * `users`: also restore the dump's users and passwords. `keepNames`: every database the dump names
 * goes back into the database of that name, even when it is the only one. `databases`: only these
 * of the dump ("" is a dump's unnamed database, the backup's main one). `renames`: a database of
 * the dump restored under another name. `tables`: only these tables of the one chosen database.
 * `into`: another database service of the same engine to restore into.
 */
export type RestoreOptions = {
  users?: boolean;
  keepNames?: boolean;
  databases?: string[];
  renames?: Record<string, string>;
  tables?: string[];
  into?: string;
  /** The passphrase of an encrypted backup made with another one (or imported). */
  passphrase?: string | null;
};

export type Commands = {
  docker: Docker;
  container: Docker.Container;
  engine: DatabaseConfig["engine"];
  backup: string;
  restore: string;
  /** Postgres: psql for plain SQL files instead of pg_restore. */
  restorePlain?: string;
  /** MongoDB: restores a backup of several databases (a packed folder of dumps). */
  restoreFolder?: string;
  /** MongoDB: restores the dump's users and roles, keeping Serve's account. */
  restoreUsers?: string;
  /** Masked in any output. */
  password: string;
  /** Database the service uses: plain SQL dumps from elsewhere are restored into it. */
  database: string;
  /** The account apps connect with: databases a restore creates are opened to it (MySQL, MariaDB). */
  username?: string;
  /** A database service's credentials (not a compose container's): restores under other names and of tables use them. */
  creds?: ReturnType<typeof databaseCreds>;
};

/**
 * What a backup reads from and writes to: a database service, or in a compose stack one of its
 * database containers (`db:<service>`), a volume (`volume:<name>`) or a host directory
 * (`dir:<path>`). Same retention and S3 handling for all of them.
 */
type Target = {
  label: string;
  /** Start of the backup file names. */
  stem: string;
  extension: string;
  s3DestinationId: string | null;
  retention: number;
  retentionS3: number;
  /** A copy stays on the server too; without it (a bucket only), it is removed once uploaded. */
  keepLocal: boolean;
  /** Backups are encrypted with it. */
  passphrase: string | null;
  dump(file: string): Promise<number>;
  /** `onStopped`: the containers a storage restore stopped (empty once they run again). */
  restore(file: string, log: (line: string) => void, onStopped?: (ids: string[]) => Promise<void>, opts?: RestoreOptions): Promise<{ out: string; format: string }>;
};

/** databases: the ones a backup takes when they are more (or other) than the main one. */
async function databaseCommands(service: ServiceRow, databases?: string[] | null): Promise<Commands> {
  const cfg = service.database;
  if (!cfg) throw new Error(`${service.name} is not a database`);
  const engine = engines[cfg.engine];
  const creds = databaseCreds(cfg, decrypt(cfg.password));
  const several = databases?.length && engine.backupDatabasesCommand ? engine.backupDatabasesCommand(creds, databases) : null;
  const { docker } = await serverOf(service);
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  return {
    docker,
    container: await databaseContainer(docker, service),
    engine: cfg.engine,
    backup: several ? several.command : engine.backupCommand(creds),
    restore: engine.restoreCommand(creds),
    restoreUsers: engine.restoreUsersCommand?.(creds),
    restoreFolder: engine.restoreFolderCommand?.(creds),
    restorePlain:
      cfg.engine === "postgres"
        ? `PGPASSWORD=${q(creds.password)} psql -X -v ON_ERROR_STOP=1 -q -o /dev/null -U ${q(creds.username)} -d ${q(pgDbname(creds.database))}`
        : undefined,
    password: creds.password,
    database: creds.database,
    username: creds.username,
    creds,
  };
}

/** Output of a short command in a container (reading a *_FILE secret). */
async function execText(container: Docker.Container, docker: Docker, cmd: string[]) {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true, stdin: false });
  const out = new PassThrough();
  let text = "";
  out.on("data", (c: Buffer) => (text += c.toString()));
  docker.modem.demuxStream(stream, out, new PassThrough());
  await new Promise<void>((resolve) => stream.on("end", resolve));
  return (await execExitCode(exec)) === 0 ? text : null;
}

async function composeCommands(service: ServiceRow, name: string): Promise<Commands> {
  const { docker } = await serverOf(service);
  const [row] = await docker.listContainers({ filters: { label: [`${LABEL.service}=${service.id}`, `com.docker.compose.service=${name}`], status: ["running"] } });
  if (!row) throw new Error(`The ${name} container of ${service.name} is not running. Start the stack first.`);
  const container = docker.getContainer(row.Id);
  const info = await container.inspect();
  // Checked again on the container itself, not only through the list filter.
  if (info.Config.Labels?.[LABEL.service] !== service.id) throw new Error(`The ${name} container does not belong to ${service.name}.`);
  const engine = engineOfImage(info.Config.Image);
  if (!engine) throw new Error(`${name} runs ${info.Config.Image}, which is not a database that can be backed up.`);
  const env: Record<string, string> = {};
  for (const line of info.Config.Env ?? []) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(env))
    if (k.endsWith("_FILE") && v.startsWith("/")) {
      const text = await execText(container, docker, ["cat", v]).catch(() => null);
      if (text !== null) files[k] = text;
    }
  const creds = credsFromEnv(engine, env, files);
  if (typeof creds === "string") throw new Error(creds);
  // Redis and Valkey often get their password on the command line: redis-server --requirepass x.
  if ((engine === "redis" || engine === "valkey") && !creds.password) creds.password = requirePass([...(info.Config.Entrypoint ?? []), ...(info.Config.Cmd ?? [])]);
  return { docker, container, engine, ...dumpCommands(engine, creds), password: creds.password, database: creds.database ?? "", username: creds.username };
}

/**
 * Dumps through a database container into a file on this machine. The dump streams back. Returns the size.
 * `lowPriority` runs it under nice 19 (a priority, not a cap: Docker cannot limit the CPU of one command
 * in a running container); `timeoutMinutes` stops it, and every process it started, when it runs longer.
 */
async function dumpWith(t: Commands, file: string, opts: { timeoutMinutes?: number | null; lowPriority?: boolean } = {}) {
  const marker = `SERVE_EXEC=${crypto.randomBytes(8).toString("hex")}`;
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  // Images without nice (rare) dump at the usual priority.
  const command = opts.lowPriority ? `if command -v nice >/dev/null 2>&1; then exec nice -n 19 sh -c ${q(t.backup)}; else exec sh -c ${q(t.backup)}; fi` : t.backup;
  const exec = await t.container.exec({ Cmd: ["sh", "-c", command], AttachStdout: true, AttachStderr: true, Env: [marker] });
  const stream = await exec.start({ hijack: true, stdin: false });
  let timedOut = false;
  const timer = opts.timeoutMinutes
    ? setTimeout(() => {
        timedOut = true;
        (stream as unknown as { destroy: (e?: Error) => void }).destroy(new Error("timeout"));
      }, opts.timeoutMinutes * 60_000)
    : undefined;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let errText = "";
  stderr.on("data", (c: Buffer) => (errText += c.toString()));
  t.docker.modem.demuxStream(stream, stdout, stderr);
  stream.on("end", () => {
    stdout.end();
    stderr.end();
  });
  stream.on("error", (e: Error) => stdout.destroy(e));
  // MySQL, MariaDB and ClickHouse dump plain SQL: it is compressed here, on its way to the file
  // (the database images need no gzip). Others compress themselves or write binary formats.
  const compress = (t.engine === "mysql" || t.engine === "mariadb" || t.engine === "clickhouse") && file.endsWith(".gz");
  try {
    if (compress) await pipeline(stdout, zlib.createGzip({ level: 6 }), fs.createWriteStream(file));
    else await pipeline(stdout, fs.createWriteStream(file));
  } catch (e) {
    if (!timedOut) throw e;
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
    // Docker has no call to stop an exec: its processes are found by the marker and killed.
    const { killMarked } = await import("@/server/services/exec");
    await killMarked(t.container, marker);
    throw new Error(`The backup took longer than ${opts.timeoutMinutes} minutes and was stopped.`);
  }
  // The output ended; a large dump may still take a moment to exit.
  const exitCode = await execExitCode(exec, 60_000);
  const masked = t.password ? errText.replaceAll(t.password, "***") : errText;
  if (exitCode !== 0) throw new Error(masked.trim() || (exitCode === null ? "The backup command did not finish" : `Backup command exited with ${exitCode}`));
  const { size } = await fs.promises.stat(file);
  if (size === 0) throw new Error(masked.trim() || "Backup produced an empty file");
  return size;
}

/** Output lines that say nothing about the restore. */
const NOISE = /Using a password on the command line interface can be insecure|^\s*$/;

/**
 * Run a shell command in a database container with `input` on stdin. Returns its output with the
 * password masked; `onOutput` also gets it as it comes, about once a second.
 */
async function runIn(t: Commands, command: string, input: NodeJS.ReadableStream, gz: boolean, onOutput?: (text: string) => void, filter?: NodeJS.ReadWriteStream) {
  const exec = await t.container.exec({ Cmd: ["sh", "-c", command], AttachStdin: true, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true, stdin: true });
  let output = "";
  let pending = "";
  const mask = (text: string) => (t.password ? text.replaceAll(t.password, "***") : text);
  const flush = () => {
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    const text = mask(lines.filter((l) => !NOISE.test(l)).join("\n")).trim();
    if (text) onOutput?.(text);
  };
  const ticker = onOutput ? setInterval(flush, 1000) : null;
  const sink = new PassThrough();
  sink.on("data", (c: Buffer) => {
    // Only the end is kept: a restore that reports progress for hours would otherwise fill memory.
    output = (output + c.toString()).slice(-65536);
    if (onOutput) pending += c.toString();
  });
  t.docker.modem.demuxStream(stream, sink, sink);
  const done = new Promise<void>((resolve) => {
    stream.on("end", resolve);
    stream.on("close", resolve);
  });
  // A file that cannot be read to the end (a corrupt gzip) fails the restore, even when the command accepted what it got.
  const stages: NodeJS.ReadWriteStream[] = [...(gz ? [zlib.createGunzip()] : []), ...(filter ? [filter] : [])];
  const readError = await pipeline([input, ...stages, stream as unknown as NodeJS.WritableStream], { end: false }).then(
    () => null,
    (e: Error) => e,
  );
  (stream as unknown as { end: () => void }).end();
  await done;
  const exitCode = await execExitCode(exec, 60_000);
  if (ticker) {
    clearInterval(ticker);
    pending += "\n";
    flush();
  }
  const clean = mask(output).trim();
  // Output already in the log: the error names its last line only.
  const summary = onOutput
    ? (clean
        .split("\n")
        .filter((l) => l.trim())
        .at(-1) ?? "")
    : clean.slice(-1500);
  if (exitCode !== null && exitCode !== 0) throw new Error(summary || `Command exited with ${exitCode}`);
  if (readError) throw new Error(`Reading the file failed: ${readError.message}`);
  if (exitCode === null) throw new Error(clean.slice(-1500) || "The command did not finish");
  return clean;
}

/** Restores a dump into a database container; Redis and Valkey restart to load it. */
export async function restoreWith(t: Commands, file: string, log: (line: string) => void = () => {}, opts: RestoreOptions = {}): Promise<{ out: string; format: string }> {
  if (opts.tables?.length) return restoreTables(t, file, log, opts);
  // Mongo archives are gzip streams already; everything else ending in .gz is unpacked on the way in.
  const gz = /\.gz$/i.test(file) && t.engine !== "mongodb";
  let { command, format } = await restoreCommandFor(t, file, gz);
  // The dump's unnamed database (a custom dump, or SQL without a database switch) under another
  // name: the restore connects to that one instead of the service's.
  const renamed = opts.renames?.[""];
  if (renamed && t.creds && t.engine !== "mongodb") {
    await ensureDatabase(t, renamed);
    if (format === "pg_dump custom format") command = engines.postgres.restoreCommand({ ...t.creds, database: renamed });
    else if (t.engine === "postgres") command = `${clientOf(t, renamed)} -o /dev/null`;
    else command = `MYSQL_PWD=${shq(t.password)} ${t.engine} -uroot ${shq(renamed)}`;
  }
  if (t.engine === "mongodb" && !/\.dir\.tar\.gz$/i.test(file)) command += mongoNamespaces(opts);
  log(`Format: ${format}${gz ? " (gzip)" : ""}`);
  const sql = format === "plain SQL" || t.engine === "mysql" || t.engine === "mariadb";
  const filter = sql ? await plainSqlFilter(t, file, gz, log, opts) : undefined;
  // The command's output goes to the log while it runs, so a long or failing restore can be followed.
  const out = await runIn(t, command, fs.createReadStream(file), gz, log, filter);
  if (opts.users && (t.engine === "mysql" || t.engine === "mariadb")) {
    log("Restoring the dump's users and their rights; Serve's own accounts keep theirs");
    const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
    await runIn(t, `export MYSQL_PWD=${q(t.password)}; ${t.engine} -uroot`, Readable.from([accountsMergeSql(protectedAccounts(t))]), false, log);
  }
  // A backup of chosen databases (a packed folder) holds no users: they live in admin.
  if (opts.users && t.restoreUsers && !/\.dir\.tar\.gz$/i.test(file)) {
    log("Restoring the users of the dump; the account Serve connects with keeps its password");
    await runIn(t, t.restoreUsers, fs.createReadStream(file), gz, log);
  }
  if (t.engine === "redis" || t.engine === "valkey") {
    log("Restarting to load the dump");
    await t.container.restart();
  }
  return { out, format: `${format}${gz ? " (gzip)" : ""}` };
}

const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** A client in the database container, signed in as Serve: psql (to the postgres database) or mysql as root. */
function clientOf(t: Commands, database = "postgres") {
  if (t.engine === "postgres") return `PGPASSWORD=${shq(t.password)} psql -X -v ON_ERROR_STOP=1 -q -U ${shq(t.username ?? "postgres")} -d ${shq(pgDbname(database))}`;
  return `MYSQL_PWD=${shq(t.password)} ${t.engine} -uroot`;
}

/** Runs SQL in the database container as Serve. */
async function runSql(t: Commands, sqlText: string, database?: string) {
  await runIn(t, clientOf(t, database), Readable.from([`${sqlText}\n`]), false);
}

const pgIdent = (v: string) => `"${v.replaceAll('"', '""')}"`;
const myIdent = (v: string) => `\`${v.replaceAll("`", "``")}\``;

/** Creates a database when it is missing; on MySQL the account apps connect with gets it too. */
async function ensureDatabase(t: Commands, name: string) {
  if (t.engine === "postgres") {
    await runSql(
      t,
      `SELECT 'CREATE DATABASE ${pgIdent(name).replaceAll("'", "''")}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${name.replaceAll("'", "''")}')\\gexec`,
    );
    return;
  }
  const grant = t.username && t.username !== "root" ? ` GRANT ALL PRIVILEGES ON ${myIdent(name)}.* TO '${t.username.replaceAll("'", "''")}'@'%';` : "";
  await runSql(t, `CREATE DATABASE IF NOT EXISTS ${myIdent(name)};${grant}`);
}

async function dropDatabase(t: Commands, name: string) {
  await runSql(t, t.engine === "postgres" ? `DROP DATABASE IF EXISTS ${pgIdent(name)} WITH (FORCE);` : `DROP DATABASE IF EXISTS ${myIdent(name)};`).catch(() => {});
}

/** mongorestore flags for chosen databases and new names (its namespaces are database.collection). */
function mongoNamespaces(opts: RestoreOptions) {
  const flags: string[] = [];
  for (const d of opts.databases ?? []) if (d) flags.push(`--nsInclude=${shq(`${d}.*`)}`);
  for (const [from, to] of Object.entries(opts.renames ?? {})) if (from && to && from !== to) flags.push(`--nsFrom=${shq(`${from}.*`)}`, `--nsTo=${shq(`${to}.*`)}`);
  return flags.length ? ` ${flags.join(" ")}` : "";
}

/**
 * Only some tables: the chosen database goes into a temporary database first, then the tables are
 * copied from there with the engine's own dump tool (indexes, keys and their data together), and
 * the temporary database is dropped. Tables of the same name are replaced; others stay as they are.
 */
async function restoreTables(t: Commands, file: string, log: (line: string) => void, opts: RestoreOptions): Promise<{ out: string; format: string }> {
  if (t.engine !== "postgres" && t.engine !== "mysql" && t.engine !== "mariadb") throw new Error("Restoring single tables works for Postgres, MySQL and MariaDB.");
  const tables = opts.tables ?? [];
  const src = opts.databases?.[0] ?? "";
  const final = opts.renames?.[src] || (opts.keepNames && src ? src : t.database);
  const tmp = `serve_restore_${crypto.randomBytes(4).toString("hex")}`;
  log(`Restoring ${tables.length === 1 ? "1 table" : `${tables.length} tables`} into ${final}: ${tables.join(", ")}`);
  try {
    const { format } = await restoreWith(t, file, log, { ...opts, tables: undefined, users: false, keepNames: true, databases: src ? [src] : undefined, renames: { [src]: tmp } });
    await ensureDatabase(t, final);
    log(`Copying the tables into ${final}`);
    if (t.engine === "postgres") {
      const pgDump = `PGPASSWORD=${shq(t.password)} pg_dump -U ${shq(t.username ?? "postgres")} -d ${shq(pgDbname(tmp))} --clean --if-exists --no-owner --no-privileges ${tables.map((x) => `-t ${shq(x)}`).join(" ")}`;
      await runIn(t, `${pgDump} | ${clientOf(t, final)}`, Readable.from([]), false, log);
    } else {
      const dump = t.engine === "mariadb" ? "$(command -v mariadb-dump || echo mysqldump)" : "mysqldump";
      await runIn(
        t,
        `export MYSQL_PWD=${shq(t.password)}; ${dump} -uroot --single-transaction ${shq(tmp)} ${tables.map(shq).join(" ")} | ${t.engine} -uroot ${shq(final)}`,
        Readable.from([]),
        false,
        log,
      );
    }
    return { out: "", format };
  } finally {
    await dropDatabase(t, tmp);
  }
}

/** Dump a database service into a file on this machine. Returns the size. */
/**
 * Dumps a database container Serve does not manage (one being copied into a project), with the
 * same commands as a backup. `databases`: every database of it, where the engine takes several.
 */
export async function dumpOutsideDatabase(
  docker: Docker,
  containerId: string,
  engine: DatabaseConfig["engine"],
  creds: { username: string; password: string; database: string },
  databases: string[] | null,
  file: string,
) {
  const e = engines[engine];
  const c = { ...creds, tlsRequired: false };
  const several = databases?.length && e.backupDatabasesCommand ? e.backupDatabasesCommand(c, databases) : null;
  const t = {
    docker,
    container: docker.getContainer(containerId),
    engine,
    backup: several ? several.command : e.backupCommand(c),
    restore: "",
    password: creds.password,
    database: creds.database,
  } satisfies Commands;
  return { size: await dumpWith(t, file), extension: several ? several.extension : e.backupExtension };
}

export async function dumpDatabase(service: ServiceRow, file: string) {
  return dumpWith(await databaseCommands(service), file);
}

/** Run a shell command in a database container with `input` on stdin. Returns its output with the password masked. */
export async function runWithInput(service: ServiceRow, command: string, input: NodeJS.ReadableStream, gz: boolean, password: string) {
  return runIn({ ...(await databaseCommands(service)), password }, command, input, gz);
}

/** Restore a dump file (made by dumpDatabase for the same engine) into a database service. */
export async function restoreDumpFile(service: ServiceRow, file: string) {
  return (await restoreWith(await databaseCommands(service), file)).out;
}

const fileSafe = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-40) || "data";

/** Short hash of a backup key: names that squash to the same text still get their own files. */
const keyHash = (key: string) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 6);

/** The target of a backup row: a compose key when it has one, else the database service. */
export async function targetOf(service: ServiceRow, key: string | null, databases?: string[] | null): Promise<Target> {
  if (!key) {
    const cfg = service.database;
    if (!cfg) throw new Error(`${service.name} is not a database`);
    const engine = engines[cfg.engine];
    const several = databases?.length && engine.backupDatabasesCommand ? engine.backupDatabasesCommand(databaseCreds(cfg, ""), databases) : null;
    return {
      label: service.name,
      stem: service.slug,
      extension: several ? several.extension : engine.backupExtension,
      s3DestinationId: cfg.s3DestinationId ?? null,
      retention: cfg.backupRetention,
      retentionS3: cfg.backupRetentionS3 ?? cfg.backupRetention,
      keepLocal: !cfg.s3DestinationId || cfg.backupLocal !== false,
      passphrase: cfg.backupPassphrase ? decrypt(cfg.backupPassphrase) : null,
      dump: async (file) => dumpWith(await databaseCommands(service, databases), file, { timeoutMinutes: cfg.backupTimeoutMinutes, lowPriority: cfg.backupLowPriority }),
      restore: async (file, log, _onStopped, opts) => restoreWith(await databaseCommands(service), file, log, opts),
    };
  }
  const parsed = parseBackupKey(key);
  if (!parsed || (service.type !== "compose" && service.type !== "app")) throw new Error("This backup does not belong to this service.");
  if (parsed.kind === "db" && service.type !== "compose") throw new Error("Database backups of containers are for compose stacks.");
  const cfg = service.composeBackups?.[key];
  const base = {
    s3DestinationId: cfg?.s3DestinationId ?? null,
    retention: cfg?.retention ?? 7,
    retentionS3: cfg?.retentionS3 ?? cfg?.retention ?? 7,
    keepLocal: !cfg?.s3DestinationId || cfg.local !== false,
    passphrase: cfg?.passphrase ? decrypt(cfg.passphrase) : null,
  };
  if (parsed.kind === "db") {
    const commands = await composeCommands(service, parsed.name);
    return {
      ...base,
      label: `${service.name} / ${parsed.name}`,
      stem: `${service.slug}-${fileSafe(parsed.name)}-${keyHash(key)}`,
      extension: DUMP_EXTENSION[commands.engine],
      dump: (file) => dumpWith(commands, file, { timeoutMinutes: cfg?.timeoutMinutes, lowPriority: cfg?.lowPriority }),
      restore: (file, log, _onStopped, opts) => restoreWith(commands, file, log, opts),
    };
  }
  // Storage: only a volume or directory the stack's own containers mount.
  const server = await serverOf(service);
  const { docker } = server;
  const source = { kind: parsed.kind, source: parsed.name };
  const mounted = (await stackStorage(server, service.id)).some((m) => m.kind === source.kind && m.source === source.source);
  if (!mounted) throw new Error(`${parsed.name} is not mounted by ${service.name} any more.`);
  return {
    ...base,
    label: `${service.name} / ${parsed.name}`,
    stem: `${service.slug}-${fileSafe(parsed.name)}-${keyHash(key)}`,
    extension: "tar.gz",
    dump: (file) => dumpStorage(docker, source, file),
    restore: async (file, log, onStopped) => ({ out: await restoreStorage(docker, service.id, source, file, log, onStopped), format: "tar.gz" }),
  };
}

/**
 * The databases a backup takes now: null for the engine's usual backup (the main database;
 * every database on MongoDB). Chosen ones the server no longer has are left out, with a line
 * in the log; none left takes the usual backup.
 */
/**
 * The databases of a database service a backup can take: its main database and the others on the
 * server (PostgreSQL's "postgres" included), without the copies made for branches (those go with
 * the branch's own backups).
 */
export async function backupableDatabases(service: ServiceRow): Promise<string[] | null> {
  const cfg = service.database;
  if (!cfg) return null;
  const { listDatabases } = await import("@/server/databases/list");
  const found = await listDatabases(service).catch(() => null);
  if (!found) return null;
  const branchRows = await db
    .select({ database: schema.databaseBranch.database, extra: schema.databaseBranch.extraDatabases, name: schema.databaseBranch.name })
    .from(schema.databaseBranch)
    .where(eq(schema.databaseBranch.serviceId, service.id));
  const { copyDatabaseName } = await import("@/server/databases/branches");
  const copies = new Set(branchRows.flatMap((b) => [b.database, ...b.extra.map((d) => copyDatabaseName(d, b.name))]));
  // PostgreSQL's own "postgres" database is often used for data too: it is offered like the others.
  const own = cfg.engine === "postgres" ? ["postgres"] : [];
  return [...new Set([cfg.database, ...found, ...own])].filter((d) => d && !copies.has(d)).sort();
}

async function backupDatabasesNow(service: ServiceRow, asked: string[] | null, log: (line: string) => Promise<void>) {
  const cfg = service.database;
  if (!cfg || !asked?.length || !engines[cfg.engine].backupDatabasesCommand) return null;
  // Every database: the ones on the server at the time of the backup, new ones included.
  let chosen = asked;
  // MongoDB's usual backup already takes every database, in one archive.
  const { all: every, skip } = readChoice(asked);
  // MongoDB's usual backup takes every database in one archive; with some left out it goes one by one.
  if (every && !skip.length && cfg.engine === "mongodb") return null;
  if (every) {
    const all = await backupableDatabases(service);
    if (!all) {
      await log("Could not list the databases of the server: backing up the main database only.");
      return null;
    }
    chosen = all.filter((d) => !skip.includes(d));
    if (skip.length) await log(`Leaving out ${skip.join(", ")}.`);
    if (!chosen.length) {
      await log("Every database is left out: backing up the main database.");
      return null;
    }
  }
  // Only the main database: the usual backup (and file format) is that.
  if (chosen.length === 1 && chosen[0] === cfg.database && cfg.engine !== "mongodb") return null;
  const { listDatabases } = await import("@/server/databases/list");
  const found = await listDatabases(service).catch(() => null);
  if (!found) return chosen;
  const kept = chosen.filter((d) => found.includes(d) || (d === cfg.database && cfg.engine !== "mongodb") || (d === "postgres" && cfg.engine === "postgres"));
  for (const d of chosen.filter((x) => !kept.includes(x))) await log(`Left out ${d}: the server has no database by that name any more.`);
  return kept.length ? kept : null;
}

/** Takes a backup. `protect` is a backup retention must keep (the one a safety backup precedes). */
/** SHA-256 of a file, read as a stream. */
export async function fileSha256(file: string) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

/** Fails when the file is not the one the backup wrote (damaged on disk, or in the bucket). Older backups have no checksum. */
async function checkIntegrity(backup: { id: string; checksum: string | null }, file: string) {
  if (!backup.checksum) return;
  const now = await fileSha256(file);
  if (now !== backup.checksum) throw new Error("The backup file is damaged: its checksum does not match the one recorded when it was made. Nothing was restored.");
  await logLine(backup.id, "Checksum verified");
}

export async function runBackup(backupId: string, protect?: string) {
  const backup = await db.query.backup.findFirst({
    where: eq(schema.backup.id, backupId),
    with: { service: true },
  });
  if (!backup) return;
  const service = backup.service;
  if (!backup.target && !service.database) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  let file: string | null = null;
  let label = service.name;

  try {
    // The databases asked for (this backup's, else the service's choice), those still there.
    const databases = backup.target ? null : await backupDatabasesNow(service, backup.databases ?? service.database?.backupDatabases ?? null, (l) => logLine(backup.id, l));
    const t = await targetOf(service, backup.target, databases);
    label = t.label;
    // What it takes, not what was asked: chosen databases the server no longer has are not in it,
    // and with none left it is the usual backup of the main database (null).
    if (!backup.target && (databases || backup.databases)) await db.update(schema.backup).set({ databases }).where(eq(schema.backup.id, backup.id));
    let filename = `${t.stem}-${stamp}.${t.extension}`;
    file = backupFile(service.id, filename);
    // Known before the dump starts, so a restart mid-way can remove the partial file.
    await db.update(schema.backup).set({ filename }).where(eq(schema.backup.id, backup.id));
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    let size = await t.dump(file);
    let hint: string | null = null;
    if (t.passphrase) {
      // Encrypted before it is stored or uploaded; the plain dump never stays on disk.
      const plain = file;
      file = `${plain}${ENCRYPTED_SUFFIX}`;
      filename = `${filename}${ENCRYPTED_SUFFIX}`;
      await db.update(schema.backup).set({ filename }).where(eq(schema.backup.id, backup.id));
      try {
        await encryptFile(plain, file, t.passphrase);
      } finally {
        await fs.promises.rm(plain, { force: true });
      }
      size = (await fs.promises.stat(file)).size;
      hint = keyHint(t.passphrase);
      await logLine(backup.id, "Encrypted with the backup passphrase");
    }
    const checksum = await fileSha256(file);

    await logLine(backup.id, `Dumped ${filename} (${size} bytes, SHA-256 ${checksum.slice(0, 12)})`);

    // A failed upload keeps the local copy; the backup still counts.
    const s3 = await s3For(t.s3DestinationId);
    let s3Status: "uploaded" | "failed" | null = null;
    if (s3) {
      try {
        await s3Upload(s3, s3Key(s3.prefix, service.slug, filename), file);
        s3Status = "uploaded";
        await logLine(backup.id, `Uploaded to S3 bucket ${s3.bucket}`);
      } catch (e) {
        s3Status = "failed";
        await logLine(backup.id, `S3 upload failed: ${(e as Error).message}`);
      }
    }

    await db
      .update(schema.backup)
      .set({ status: "success", filename, size, checksum, keyHint: hint, destination: s3Status === "uploaded" ? s3!.id : "local", s3Status, finishedAt: new Date() })
      .where(eq(schema.backup.id, backup.id));
    // The backup is done: a failing cleanup of older ones must not undo it.
    await applyRetention(service.id, backup.target, t.keepLocal ? t.retention : 0, t.retentionS3, protect).catch((e) =>
      logLine(backup.id, `Removing old backups failed: ${(e as Error).message}`).catch(() => {}),
    );
    if (backup.trigger === "schedule") {
      void notify(await orgOfService(service.id), "backup.success", {
        ok: true,
        title: `Backup of ${label} finished`,
        body: filename,
        url: `/projects/${service.projectId}/services/${service.id}/backups`,
        serviceId: service.id,
        dedupKey: `backup:${service.id}:${backup.target ?? ""}`,
        data: { backupId: backup.id, filename, size, s3: s3Status },
      });
    }
  } catch (error) {
    if (file) await fs.promises.rm(file, { force: true });
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(schema.backup)
      .set({ status: "failed", error: message.slice(0, 2000), finishedAt: new Date(), filename: null })
      .where(eq(schema.backup.id, backup.id));
    void notify(await orgOfService(service.id), "backup.failed", {
      ok: false,
      title: `Backup of ${label} failed`,
      body: message.slice(0, 400),
      url: `/projects/${service.projectId}/services/${service.id}/backups`,
      error: message.slice(0, 2000),
      serviceId: service.id,
      dedupKey: `backup:${service.id}:${backup.target ?? ""}`,
      data: { backupId: backup.id },
    });
    throw error;
  }
}

/**
 * Keeps the newest `keepLocal` backups on this machine and `keepS3` in S3. A backup
 * whose copies are all gone is removed from the list. Imported files are kept.
 */
/** keepLocal 0: copies live in the bucket only, so each one uploaded loses its file on the server (one that failed to upload keeps it). */
async function applyRetention(serviceId: string, target: string | null, keepLocal: number, keepS3: number, protect?: string) {
  const rows = await db
    .select()
    .from(schema.backup)
    .where(and(eq(schema.backup.serviceId, serviceId), eq(schema.backup.status, "success"), target ? eq(schema.backup.target, target) : isNull(schema.backup.target)))
    .orderBy(desc(schema.backup.createdAt));
  // A backup queued for a restore (marked running when queued) waits for it, after this job.
  const own = rows.filter((b) => b.trigger !== "import" && b.id !== protect && b.restoreStatus !== "running");
  const [svc] = await db.select({ slug: schema.service.slug }).from(schema.service).where(eq(schema.service.id, serviceId));
  for (const [i, b] of own.entries()) {
    if (!b.filename) continue;
    const inS3 = b.destination !== "local";
    const dropLocal = keepLocal === 0 ? inS3 : i >= Math.max(1, keepLocal);
    let dropS3 = inS3 && i >= Math.max(1, keepS3);
    if (dropLocal) await fs.promises.rm(backupFile(serviceId, b.filename), { force: true });
    if (dropS3 && svc) {
      const s3 = await s3For(b.destination);
      // A failed delete keeps the S3 copy listed, so the next run tries again.
      if (s3)
        dropS3 = await s3Delete(s3, s3Key(s3.prefix, svc.slug, b.filename)).then(
          () => true,
          () => false,
        );
      if (dropS3) await db.update(schema.backup).set({ s3Status: "deleted", destination: "local" }).where(eq(schema.backup.id, b.id));
    }
    if (dropLocal && (!inS3 || dropS3)) await db.delete(schema.backup).where(eq(schema.backup.id, b.id));
  }
}

/** Whether the backup file is still on this machine. */
export function hasLocalCopy(b: { serviceId: string; filename: string | null }) {
  return !!b.filename && fs.existsSync(backupFile(b.serviceId, b.filename));
}

/** Streams a backup stored only in S3. */
export async function openS3Backup(b: typeof schema.backup.$inferSelect) {
  if (!b.filename || b.destination === "local") return null;
  const s3 = await s3For(b.destination);
  const [svc] = await db.select({ slug: schema.service.slug }).from(schema.service).where(eq(schema.service.id, b.serviceId));
  if (!s3 || !svc) return null;
  return s3Stream(s3, s3Key(s3.prefix, svc.slug, b.filename));
}

/**
 * Removes a backup's file and its S3 copy. Only `destination` says where a copy is: a local backup
 * (an import, a failed upload, a copy retention removed) has none, and an object of the same name
 * in the service's bucket is not its own. `_s3Id` (the service's destination) is not used.
 */
export async function deleteBackupFiles(b: typeof schema.backup.$inferSelect, _s3Id?: string | null) {
  if (!b.filename) return;
  await fs.promises.rm(backupFile(b.serviceId, b.filename), { force: true });
  const s3 = b.destination !== "local" ? await s3For(b.destination) : null;
  if (s3) {
    const [svc] = await db.select({ slug: schema.service.slug }).from(schema.service).where(eq(schema.service.id, b.serviceId));
    if (svc) await s3Delete(s3, s3Key(s3.prefix, svc.slug, b.filename)).catch(() => {});
  }
}

/**
 * Cleans a plain SQL dump on its way in (see sql-filter.ts): reads it once to find its databases,
 * then leaves out users, roles and system databases. Says in the log what it changed.
 */
/** Accounts a restore never changes: the one Serve connects with, and the engine's superuser. */
const protectedAccounts = (t: Commands) => [...new Set([t.username, t.engine === "postgres" ? "postgres" : "root"].filter((u): u is string => !!u))];

async function plainSqlFilter(t: Commands, file: string, gz: boolean, log: (line: string) => void, opts: RestoreOptions) {
  const keepNames = !!opts.keepNames;
  const engine = t.engine as SqlEngine;
  const src = fs.createReadStream(file);
  const lines = readline.createInterface({ input: gz ? src.pipe(zlib.createGunzip()) : src, crlfDelay: Number.POSITIVE_INFINITY });
  const plan = await planSql(engine, lines).finally(() => src.destroy());
  const filter = sqlLineFilter(engine, plan, t.database, {
    keepNames,
    user: t.username,
    users: opts.users,
    protect: protectedAccounts(t),
    only: opts.databases,
    renames: opts.renames,
  });
  const named = plan.databases.filter((d) => d !== "");
  log(
    named.length > 1 || (keepNames && named.length === 1)
      ? `The dump holds ${named.length === 1 ? "the database" : `${named.length} databases`} (${named.join(", ")}); each is restored as a database of its own.`
      : named[0] && named[0] !== t.database
        ? `Restoring the dump's database ${named[0]} into ${t.database}.`
        : `Restoring into ${t.database || "the database"}.`,
  );
  log(
    opts.users
      ? "The dump's users, roles and rights are restored too, except Serve's own accounts, which stay as they are."
      : "Users, passwords, grants and system databases of the dump are left out, so the account Serve connects with stays as it is.",
  );
  return sqlFilterStream(filter);
}

/** First bytes of a backup (after gunzip for .gz files), to tell dump formats apart. */
async function peek(file: string, gz: boolean, bytes = 8): Promise<Buffer> {
  const src = fs.createReadStream(file);
  const stream = gz ? src.pipe(zlib.createGunzip()) : src;
  try {
    for await (const chunk of stream) return (chunk as Buffer).subarray(0, bytes);
    return Buffer.alloc(0);
  } catch {
    return Buffer.alloc(0);
  } finally {
    src.destroy();
  }
}

/** The command that restores this file: pg_restore for custom dumps, psql for plain SQL. */
async function restoreCommandFor(t: Commands, file: string, gz: boolean) {
  if (t.restoreFolder && /\.dir\.tar\.gz$/i.test(file)) return { command: t.restoreFolder, format: "dumps of several databases" };
  if (t.engine === "postgres" && t.restorePlain) {
    const head = await peek(file, gz, 5);
    if (head.toString("latin1") !== "PGDMP") return { command: t.restorePlain, format: "plain SQL" };
    return { command: t.restore, format: "pg_dump custom format" };
  }
  return { command: t.restore, format: DUMP_EXTENSION[t.engine] };
}

/** Another database service to restore into: same organization and engine. */
async function intoService(source: ServiceRow, id: string) {
  const [row] = await db
    .select({ service: schema.service, org: schema.project.organizationId })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(eq(schema.service.id, id));
  const [from] = await db.select({ org: schema.project.organizationId }).from(schema.project).where(eq(schema.project.id, source.projectId));
  if (!row || row.org !== from?.org || row.service.type !== "database" || row.service.database?.engine !== source.database?.engine)
    throw new Error("Restore into a database service of the same kind in this organization.");
  return row.service;
}

/** The backup's file on this machine, downloaded from S3 when only the copy there is left. */
export async function localBackupFile(backup: typeof schema.backup.$inferSelect & { service: ServiceRow }) {
  const file = backupFile(backup.serviceId, backup.filename!);
  if (!fs.existsSync(file)) {
    const s3 = await s3For(backup.destination !== "local" ? backup.destination : null);
    if (!s3) throw new Error("The backup file is missing.");
    await logLine(backup.id, "Downloading from S3");
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await s3Download(s3, s3Key(s3.prefix, backup.service.slug, backup.filename!), file);
  }
  return file;
}

export type BackupContents = {
  /** name: as the dump calls it ("" for its unnamed database); label: what to show. */
  databases: { name: string; label: string; tables: string[] }[];
  /** Whether tables can be chosen (Postgres, MySQL, MariaDB). */
  tables: boolean;
};

const contentsCache = new Map<string, BackupContents>();

/**
 * The databases and tables inside a database backup, for choosing what to restore. SQL dumps are
 * read once; a Postgres custom dump is listed by pg_restore in the database's container. Empty
 * when nothing can be chosen (Redis, Valkey, ClickHouse, compose targets, MongoDB without a list).
 */
export async function backupContents(backupId: string, passphrase?: string | null): Promise<BackupContents> {
  const hit = contentsCache.get(backupId);
  if (hit) return hit;
  const backup = await db.query.backup.findFirst({ where: eq(schema.backup.id, backupId), with: { service: true } });
  const cfg = backup?.service.database;
  if (!backup?.filename || backup.target || !cfg) return { databases: [], tables: false };
  const main = cfg.database ?? "";
  let result: BackupContents = { databases: [], tables: false };
  if (cfg.engine === "mongodb") {
    result = { databases: (backup.databases ?? []).filter((d) => d !== "*" && !d.startsWith("!")).map((d) => ({ name: d, label: d, tables: [] })), tables: false };
  } else if (cfg.engine === "postgres" || cfg.engine === "mysql" || cfg.engine === "mariadb") {
    const opened = await openBackupFile(backup, await localBackupFile(backup), passphrase);
    const file = opened.file;
    try {
      const gz = /\.gz$/i.test(file);
      const custom = cfg.engine === "postgres" && (await peek(file, gz, 5)).toString("latin1") === "PGDMP";
      if (custom) {
        let listing = "";
        await runIn(await databaseCommands(backup.service), "pg_restore -l", fs.createReadStream(file), gz, (text) => {
          listing += `${text}\n`;
        });
        const name = listing.match(/^;\s+dbname:\s+(.+)$/m)?.[1]?.trim() ?? main;
        const tables = [...listing.matchAll(/^\d+;\s+\d+\s+\d+\s+TABLE\s+(?!DATA\s)(\S+)\s+(\S+)\s/gm)].map((m) => `${m[1]}.${m[2]}`);
        result = { databases: [{ name: "", label: name, tables: [...new Set(tables)] }], tables: true };
      } else {
        const src = fs.createReadStream(file);
        const lines = readline.createInterface({ input: gz ? src.pipe(zlib.createGunzip()) : src, crlfDelay: Number.POSITIVE_INFINITY });
        const plan = await planSql(cfg.engine, lines).finally(() => src.destroy());
        result = { databases: plan.databases.map((d) => ({ name: d, label: d || main, tables: plan.tables?.[d] ?? [] })), tables: true };
      }
    } finally {
      await opened.done();
    }
  }
  if (contentsCache.size > 200) contentsCache.clear();
  contentsCache.set(backupId, result);
  return result;
}

/** The passphrase a service's backups are made with now (null when they are not encrypted). */
function passphraseOf(service: ServiceRow, target: string | null) {
  const stored = target ? service.composeBackups?.[target]?.passphrase : service.database?.backupPassphrase;
  return stored ? decrypt(stored) : null;
}

/**
 * The backup's file ready to read: an encrypted one is decrypted next to it into a temporary file
 * (removed by `done`), with the passphrase given, else the service's when it is the one it was made with.
 */
export async function openBackupFile(backup: typeof schema.backup.$inferSelect & { service: ServiceRow }, file: string, given?: string | null) {
  if (!file.endsWith(ENCRYPTED_SUFFIX)) return { file, done: async () => {} };
  const own = passphraseOf(backup.service, backup.target);
  const passphrase = given || (own && (!backup.keyHint || keyHint(own) === backup.keyHint) ? own : null);
  if (!passphrase) throw new Error("This backup is encrypted with another passphrase. Enter it to restore.");
  const plain = path.join(path.dirname(file), `.restoring-${crypto.randomBytes(4).toString("hex")}-${path.basename(file).slice(0, -ENCRYPTED_SUFFIX.length)}`);
  await logLine(backup.id, "Decrypting");
  await decryptFile(file, plain, passphrase);
  return { file: plain, done: () => fs.promises.rm(plain, { force: true }) };
}

export async function restoreBackup(backupId: string, opts: RestoreOptions = {}) {
  const backup = await db.query.backup.findFirst({ where: eq(schema.backup.id, backupId), with: { service: true } });
  if (!backup?.filename || (!backup.target && !backup.service.database)) throw new Error("Backup not found");
  // `service` is where the data goes: the backup's own, or another database service (opts.into).
  const service = opts.into ? await intoService(backup.service, opts.into) : backup.service;
  await db.update(schema.backup).set({ restoreStatus: "running" }).where(eq(schema.backup.id, backupId));
  try {
    const t = await targetOf(service, opts.into ? null : backup.target);
    await logLine(backupId, `Restoring into ${t.label}`);
    const stored = await localBackupFile(backup);
    await checkIntegrity(backup, stored);
    const opened = await openBackupFile(backup, stored, opts.passphrase);
    const { out: clean, format } = await t
      .restore(
        opened.file,
        (line) => void logLine(backupId, line),
        async (ids) =>
          void (await db
            .update(schema.backup)
            .set({ restoreStopped: ids.length ? ids : null })
            .where(eq(schema.backup.id, backupId))),
        // Into its own service (an import, a backup): every database the dump names keeps that name,
        // as the apps' code may use it. Into another service, a single database becomes that one's.
        { ...opts, keepNames: opts.into ? !!opts.keepNames : !backup.target },
      )
      .finally(opened.done);
    // Database restores logged their format and output as they ran.
    if (format === "tar.gz" && clean) await logLine(backupId, clean.slice(-2000));
    await db.update(schema.backup).set({ restoreStatus: "success", restoredAt: new Date() }).where(eq(schema.backup.id, backupId));
    await logLine(backupId, "Restore finished");
    void notify(await orgOfService(service.id), "restore.success", {
      ok: true,
      title: `${backup.trigger === "import" ? "Import" : "Restore"} into ${t.label} finished`,
      body: backup.filename,
      url: `/projects/${service.projectId}/services/${service.id}/backups`,
      serviceId: service.id,
      data: { backupId },
    });
    return clean;
  } catch (error) {
    const message = (error as Error).message;
    await db.update(schema.backup).set({ restoreStatus: "failed", restoredAt: new Date() }).where(eq(schema.backup.id, backupId));
    await logLine(backupId, `Restore failed: ${message.slice(0, 2000)}`);
    void notify(await orgOfService(service.id), "restore.failed", {
      ok: false,
      title: `${backup.trigger === "import" ? "Import" : "Restore"} into ${service.name} failed`,
      body: message.slice(0, 400),
      url: `/projects/${service.projectId}/services/${service.id}/backups`,
      error: message.slice(0, 2000),
      serviceId: service.id,
      data: { backupId },
    });
    throw error;
  }
}

/** Largest file Serve downloads when importing from a URL. */
const MAX_IMPORT_BYTES = 20 * 1024 ** 3;

/**
 * Import job: fetch the file (URL or S3) when needed, optionally back up the current
 * data first, then restore. The import row itself becomes a restorable backup.
 */
/** File extensions Serve can restore, per engine. */
export const IMPORT_EXTENSIONS: Record<DatabaseConfig["engine"], string[]> = {
  postgres: [".dump", ".dmp", ".backup", ".sql", ".sql.gz", ".dump.gz", ".dmp.gz"],
  mysql: [".sql", ".sql.gz"],
  mariadb: [".sql", ".sql.gz"],
  mongodb: [".archive.gz", ".gz"],
  redis: [".rdb"],
  valkey: [".rdb"],
  clickhouse: [".sql", ".sql.gz"],
};

/** A safe, unique file name for an imported dump. Throws when the extension is not restorable. */
export function importFilename(engine: DatabaseConfig["engine"], slug: string, original: string) {
  const base = path
    .basename(original)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .slice(-80);
  // An encrypted backup (.enc after the usual extension) is imported as it is, decrypted when restored.
  const ext = IMPORT_EXTENSIONS[engine].find((e) => base.endsWith(e) || base.endsWith(`${e}${ENCRYPTED_SUFFIX}`));
  if (!ext) throw new Error(`Upload a ${IMPORT_EXTENSIONS[engine].join(", ")} file.`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${slug}-import-${stamp}-${base}`;
}

export async function importBackup(backupId: string, opts: RestoreOptions & { backupFirst?: boolean; url?: string; s3?: { destinationId: string; key: string } }) {
  const backup = await db.query.backup.findFirst({ where: eq(schema.backup.id, backupId), with: { service: true } });
  if (!backup?.filename || (!backup.target && !backup.service.database)) throw new Error("Import not found");
  const service = backup.service;
  const file = backupFile(service.id, backup.filename);
  try {
    if (opts.url) {
      await logLine(backupId, `Downloading ${new URL(opts.url).host}`);
      // Every hop and the connected address are checked, not only the URL the user typed.
      const { publicGet } = await import("@/server/net/public-fetch");
      const res = await publicGet(opts.url, { timeoutMs: 60_000 });
      if (res.status < 200 || res.status >= 300) {
        res.body.resume();
        throw new Error(`Download failed: HTTP ${res.status}`);
      }
      const declared = Number(res.headers["content-length"] ?? 0);
      if (declared > MAX_IMPORT_BYTES) throw new Error("The file is larger than 20 GB.");
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      let size = 0;
      const { Transform } = await import("node:stream");
      const limit = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          cb(size > MAX_IMPORT_BYTES ? new Error("The file is larger than 20 GB.") : null, chunk);
        },
      });
      await pipeline(res.body, limit, fs.createWriteStream(file));
    } else if (opts.s3) {
      const s3 = await s3For(opts.s3.destinationId);
      if (!s3) throw new Error("Backup storage not found.");
      await logLine(backupId, `Downloading s3://${s3.bucket}/${opts.s3.key}`);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await s3Download(s3, opts.s3.key.replace(/^\/+/, ""), file);
    }
    if (!fs.existsSync(file) && backup.destination !== "local") {
      const s3 = await s3For(backup.destination);
      if (s3) await s3Download(s3, s3Key(s3.prefix, service.slug, backup.filename), file);
    }
    const { size } = await fs.promises.stat(file);
    if (!size) throw new Error("The file is empty.");
    if (backup.status !== "success") {
      await db
        .update(schema.backup)
        .set({ status: "success", size, checksum: await fileSha256(file), finishedAt: new Date() })
        .where(eq(schema.backup.id, backupId));
      await logLine(backupId, `Received ${backup.filename} (${size} bytes)`);
    }
  } catch (error) {
    if (backup.status !== "success") {
      await fs.promises.rm(file, { force: true });
      await db
        .update(schema.backup)
        .set({ status: "failed", error: (error as Error).message.slice(0, 2000), finishedAt: new Date() })
        .where(eq(schema.backup.id, backupId));
    } else await restoreNotRun(backupId, `Restore failed: ${(error as Error).message.slice(0, 2000)}`);
    throw error;
  }

  if (opts.backupFirst) {
    const id = newId();
    // A backup of chosen databases replaces those: the safety backup takes the same ones, not only
    // the service's usual choice (which may be the main database alone).
    // Into another service: that one's usual backup.
    await db
      .insert(schema.backup)
      .values(
        opts.into
          ? { id, serviceId: opts.into, target: null, trigger: "pre-import", databases: null }
          : { id, serviceId: service.id, target: backup.target, trigger: "pre-import", databases: backup.databases },
      );
    await logLine(backupId, "Backing up the current data first");
    try {
      await runBackup(id, backupId);
    } catch (e) {
      await restoreNotRun(backupId, `The safety backup failed, so nothing was restored: ${(e as Error).message}`);
      throw new Error("The safety backup failed, so nothing was restored.");
    }
  }
  await restoreBackup(backupId, { users: opts.users, databases: opts.databases, renames: opts.renames, tables: opts.tables, into: opts.into, passphrase: opts.passphrase });
}

/**
 * A restore that stopped before restoreBackup ran. A restore with a safety backup comes here, and
 * it was marked running when it was queued: it must not stay "restoring" until the worker restarts.
 */
async function restoreNotRun(backupId: string, line: string) {
  await db
    .update(schema.backup)
    .set({ restoreStatus: "failed", restoredAt: new Date() })
    .where(and(eq(schema.backup.id, backupId), eq(schema.backup.restoreStatus, "running")));
  await logLine(backupId, line);
}
