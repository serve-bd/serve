import path from "node:path";
import type Docker from "dockerode";
import { decryptOrNull } from "@/server/crypto";
import type { schema } from "@/server/db";
import { execCommand } from "@/server/services/exec";
import type { DatabaseConfig, DbEngine } from "@/server/services/types";
import type { ServerCtx } from "@/server/servers/context";
import { databaseContainer } from "./container";
import { engines } from "./engines";
import { databasePlan, type DatabasePlan, type DomainCert, MONGO_REPLICA_SET } from "./options";
import { tlsDir } from "./tls";

/**
 * Read replicas of MySQL, MariaDB, MongoDB, Redis and Valkey (PostgreSQL's are in addons.ts).
 * Each replica runs the database's own image and settings on its server, copies the database once,
 * then follows it:
 *   MySQL     a dump with its GTID position, then replication by GTID; read-only
 *   MariaDB   a dump with its GTID position, then replication by GTID; read-only
 *   MongoDB   a member of the database's replica set that never votes or becomes primary
 *   Redis     replicaof the database; read-only
 */

type Service = typeof schema.service.$inferSelect;

export const REPLICATION_USER = "serve_replicator";

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** A string for a SQL statement in single quotes. */
const sqlString = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;

/** The MySQL or MariaDB client inside a container, as root, reading SQL from the command line. */
function mysqlClient(engine: DbEngine, password: string) {
  const bin = engine === "mariadb" ? "mariadb" : "mysql";
  return `MYSQL_PWD=${sh(password)} ${bin} -uroot -N -B`;
}

async function exec(docker: Docker, containerId: string, command: string, what: string, password: string, timeoutSeconds = 60) {
  const res = await execCommand(containerId, command, { docker, timeoutSeconds });
  if (res.exitCode !== 0) throw new Error(`${what}: ${res.output.replaceAll(password, "***").trim().split("\n").slice(-2).join(" ")}`);
  return res.output.trim();
}

/** Runs SQL as root in the database's container (MySQL, MariaDB). */
async function primarySql(service: Service, docker: Docker, sql: string, what: string) {
  const cfg = service.database!;
  const password = decryptOrNull(cfg.password) ?? "";
  const container = await databaseContainer(docker, service);
  return exec(docker, container.id, `${mysqlClient(cfg.engine, password)} -e ${sh(sql)}`, what, password);
}

/** mongosh in a container, as the database's root user, running a script; prints what it prints. */
function mongoEval(cfg: DatabaseConfig, password: string, script: string) {
  const tls = cfg.tls?.enabled && cfg.tls.mode === "require" ? " --tls --tlsAllowInvalidCertificates" : "";
  return `mongosh --quiet${tls} -u ${sh(cfg.username)} -p ${sh(password)} --authenticationDatabase admin --eval ${sh(script)}`;
}

async function primaryMongo(service: Service, docker: Docker, script: string, what: string, timeoutSeconds = 60) {
  const cfg = service.database!;
  const password = decryptOrNull(cfg.password) ?? "";
  const container = await databaseContainer(docker, service);
  return exec(docker, container.id, mongoEval(cfg, password, script), what, password, timeoutSeconds);
}

/** The replica set member names: the database by its own name, each replica by its own. */
export const mongoMember = (host: string) => `${host}:27017`;

/**
 * The database's side, before its replicas start:
 *   MySQL     GTIDs on (online, step by step) and a replication login
 *   MariaDB   the binary log on (set at its start: primed) and a replication login
 *   MongoDB   the replica set started with the database in it, and the replicas as members that
 *             hold copies and take reads but never vote or become primary
 * `members`: each replica's name. Also run with none, to repair a database that was a replica.
 */
export async function preparePrimary(service: Service, docker: Docker, members: string[], replicaPassword: string, log: (l: string) => void) {
  const cfg = service.database!;
  if (cfg.engine === "redis" || cfg.engine === "valkey") return;
  if (cfg.engine === "mysql" || cfg.engine === "mariadb") {
    // A replica promoted to be the database: root gets back the rights the replica took (MariaDB),
    // and it forgets the database it followed. Each runs again until done, so a half finished one completes.
    if (cfg.engine === "mariadb") await restoreRootRights(service, docker);
    const source = await primarySql(service, docker, "SHOW REPLICA STATUS", "Could not read the replication state").catch(() => "");
    if (source) {
      log("This database followed another one before: it stops following it");
      await primarySql(
        service,
        docker,
        cfg.engine === "mysql"
          ? "STOP REPLICA; RESET REPLICA ALL; RESET PERSIST IF EXISTS super_read_only; SET GLOBAL super_read_only = OFF; SET GLOBAL read_only = OFF;"
          : // It starts without --read-only already, so only replication is left.
            "STOP SLAVE; RESET SLAVE ALL;",
        "Could not stop following the old database",
      );
    }
    if (!members.length) return;
    if (cfg.engine === "mysql") {
      // GTIDs let a replica pick up exactly where its copy ends. They are turned on online, one step at a time.
      const mode = await primarySql(service, docker, "SELECT @@GLOBAL.gtid_mode", "Could not read the GTID mode");
      if (mode !== "ON") {
        log("Turning on GTIDs for replication (no restart)");
        await primarySql(service, docker, "SET PERSIST enforce_gtid_consistency = ON", "Could not turn on GTID consistency");
        const steps = ["OFF_PERMISSIVE", "ON_PERMISSIVE", "ON"];
        for (const step of steps.slice(Math.max(0, steps.indexOf(mode) + 1))) {
          if (step === "ON") {
            // Transactions started before GTIDs must finish first.
            for (let i = 0; i < 60; i++) {
              const open = await primarySql(service, docker, "SHOW STATUS LIKE 'Ongoing_anonymous_transaction_count'", "Could not read open transactions");
              if (open.endsWith("\t0")) break;
              await new Promise((r) => setTimeout(r, 1000));
            }
          }
          await primarySql(service, docker, `SET PERSIST gtid_mode = ${step}`, `Could not set the GTID mode to ${step}`);
        }
      }
    } else {
      const binlog = await primarySql(service, docker, "SELECT @@GLOBAL.log_bin", "Could not read the binary log setting");
      if (binlog !== "1") throw new Error("The database runs without a binary log: redeploy it once so replicas can follow it.");
    }
    const user = `${sqlString(REPLICATION_USER)}@'%'`;
    await primarySql(
      service,
      docker,
      `CREATE USER IF NOT EXISTS ${user} IDENTIFIED BY ${sqlString(replicationPassword(cfg.engine, replicaPassword))}; ALTER USER ${user} IDENTIFIED BY ${sqlString(replicationPassword(cfg.engine, replicaPassword))}; GRANT REPLICATION SLAVE ON *.* TO ${user};`,
      "Could not create the replication login",
    );
    return;
  }
  if (cfg.engine === "mongodb") await prepareMongoPrimary(service, docker, members, log);
}

/** MariaDB: root gets back the rights it had before this database was a read-only replica. */
async function restoreRootRights(service: Service, docker: Docker) {
  const cfg = service.database!;
  const password = decryptOrNull(cfg.password) ?? "";
  const dir = await primarySql(service, docker, "SELECT @@datadir", "Could not read the data directory");
  const file = path.posix.join(dir, ROOT_RIGHTS_FILE);
  const container = await databaseContainer(docker, service);
  const saved = await execCommand(container.id, `cat ${sh(file)} 2>/dev/null`, { docker, timeoutSeconds: 10 }).catch(() => null);
  const rows = (saved?.exitCode === 0 ? saved.output : "")
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((r) => r.length === 2 && r[1].trim().startsWith("{"));
  if (!rows.length) return;
  const sql = rows.map(([host, priv]) => `UPDATE mysql.global_priv SET Priv = ${sqlString(priv.trim())} WHERE User = 'root' AND Host = ${sqlString(host)};`).join(" ");
  await primarySql(service, docker, `${sql} FLUSH PRIVILEGES;`, "Could not give root its rights back");
  await exec(docker, container.id, `rm -f ${sh(file)}`, "Could not tidy the data directory", password);
}

/**
 * The replica set as Serve wants it: the database as its only voting member under its own name, and
 * a non-voting, never-primary member per replica. Started when new; forced back to that shape when
 * the database finds itself outside it (a replica promoted to be the database).
 */
async function prepareMongoPrimary(service: Service, docker: Docker, members: string[], log: (l: string) => void) {
  const self = mongoMember(service.slug);
  const wanted = JSON.stringify({ self, members, set: MONGO_REPLICA_SET });
  const script = `
const want = ${wanted};
// mongosh throws on a failed command (at the top level only: it awaits there), and the error's
// code is what tells "not started yet".
let status;
try { status = db.adminCommand({ replSetGetStatus: 1 }); } catch (e) { status = { ok: 0, code: e.code, errmsg: e.message }; }
if (status.code === 94) {
  db.adminCommand({ replSetInitiate: { _id: want.set, members: [{ _id: 0, host: want.self }] } });
  print("initiated");
} else {
  const conf = db.adminCommand({ replSetGetConfig: 1 }).config;
  const me = conf.members.find((m) => m.host === want.self);
  if (!me || status.myState === 10) {
    // Not in its own set (it was a replica): it becomes the only member, under the database's name.
    const keep = me ?? conf.members.find((m) => m.self) ?? conf.members[0];
    conf.members = [{ _id: keep._id, host: want.self, priority: 1, votes: 1 }];
    conf.version++;
    db.adminCommand({ replSetReconfig: conf, force: true });
    print("repaired");
  }
}
for (let i = 0; i < 60 && !db.hello().isWritablePrimary; i++) sleep(1000);
if (!db.hello().isWritablePrimary) throw new Error("the database did not become the replica set's primary");
let conf = db.adminCommand({ replSetGetConfig: 1 }).config;
const hosts = conf.members.map((m) => m.host);
const extra = conf.members.filter((m) => m.host !== want.self && !want.members.includes(m.host));
const missing = want.members.filter((h) => !hosts.includes(h));
if (extra.length || missing.length) {
  let next = Math.max(...conf.members.map((m) => m._id)) + 1;
  conf.members = conf.members.filter((m) => !extra.includes(m));
  for (const host of missing) conf.members.push({ _id: next++, host, priority: 0, votes: 0 });
  conf.version++;
  const res = db.adminCommand({ replSetReconfig: conf });
  if (!res.ok) throw new Error(res.errmsg);
  print("members " + (missing.length ? "+" + missing.length : "") + (extra.length ? " -" + extra.length : ""));
}`;
  const out = await primaryMongo(service, docker, script, "Could not set up the replica set", 120);
  if (out.includes("initiated")) log("Started the replica set");
  if (out.includes("repaired")) log("The replica set has this database as its primary again");
}

/** What a replica's container runs with, for engines other than PostgreSQL. */
export type ReplicaSpec = {
  image: string;
  env: Record<string, string>;
  cmd: string[];
  healthcheck: string[];
  binds: string[];
  /** Files written on the replica's server before it starts. */
  files: { path: string; content: string; mode?: number }[];
  dataMountPath: string;
  /** Container port its public port leads to. */
  publicTarget: number;
};

/** MySQL refuses replication passwords longer than 32 characters. */
export const replicationPassword = (engine: DbEngine, password: string) => (engine === "mysql" || engine === "mariadb" ? password.slice(0, 32) : password);

/** Where a replica keeps the error of its last failed copy: the container's own files, kept across restarts. */
const COPY_ERROR = "/var/lib/serve-replica/error";
/** MariaDB: root's rights before the replica took one away, in its data directory. */
const ROOT_RIGHTS_FILE = ".serve-root-rights";
/** In the data directory once the copy finished: without it, a started copy is wiped and tried again. */
const COPY_DONE = ".serve-replica-ready";

/**
 * Wraps a MySQL or MariaDB replica's start (as root, before the image's entrypoint): a data
 * directory whose copy never finished is emptied, so the image initializes it and copies again.
 */
function retryCopyWrapper(dataDir: string, inner: string[]) {
  const step = [
    `mkdir -p ${path.posix.dirname(COPY_ERROR)} && chmod 777 ${path.posix.dirname(COPY_ERROR)}`,
    `if [ -d ${dataDir}/mysql ] && [ ! -f ${dataDir}/${COPY_DONE} ]; then echo "The last copy did not finish: starting over"; find ${dataDir} -mindepth 1 -delete; fi`,
    'exec "$@"',
  ].join("\n");
  // The image's entrypoint runs its own start; a TLS start (sh -c ...) runs it itself.
  return ["sh", "-c", step, "sh", ...(inner[0] === "sh" ? inner : ["docker-entrypoint.sh", ...inner])];
}

/**
 * The shell around a replica's copy steps: their errors go to the log and, when one fails, its
 * last lines are kept (COPY_ERROR) for the replicas card; the next start tries again from scratch.
 */
function copyScript(dataDir: string, steps: string) {
  // bash for pipefail: a dump that breaks half way must fail the copy, not end it early.
  return `#!/bin/bash
set -eo pipefail
exec 3>&2 2>/tmp/serve-replica.err
trap 'code=$?; cat /tmp/serve-replica.err >&3; if [ $code -ne 0 ]; then { printf "%s" "$STEP"; tail -c 400 /tmp/serve-replica.err | grep -v "Using a password" | tail -n 2 | sed "s/^/: /"; } > ${COPY_ERROR}; fi' EXIT
${steps}
touch ${dataDir}/${COPY_DONE} && rm -f ${COPY_ERROR}
echo "Copy finished" >&3
`;
}

/** A MySQL replica's first run: copy the database with its GTID position, then follow it. */
function mysqlInitScript(dataDir: string) {
  return copyScript(
    dataDir,
    `export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"
L() { mysql --protocol=socket -uroot "$@"; }
STEP="Could not prepare the replica"
L -e "SET GLOBAL super_read_only = OFF; SET GLOBAL read_only = OFF;"
L -e "RESET BINARY LOGS AND GTIDS" 2>/dev/null || L -e "RESET MASTER"
STEP="Could not reach the database at $PRIMARY_HOST"
echo "Waiting for $PRIMARY_HOST" >&3
n=0; until mysqladmin ping -h "$PRIMARY_HOST" -uroot --silent --get-server-public-key 2>/dev/null; do n=$((n+1)); [ $n -lt 150 ] || exit 1; sleep 2; done
STEP="Could not copy the database"
echo "Copying the database from $PRIMARY_HOST" >&3
mysqldump -h "$PRIMARY_HOST" -uroot --get-server-public-key --all-databases --single-transaction --routines --events --triggers --set-gtid-purged=ON | L
L -e "FLUSH PRIVILEGES"
STEP="Could not start following the database"
L -e "CHANGE REPLICATION SOURCE TO SOURCE_HOST='$PRIMARY_HOST', SOURCE_PORT=3306, SOURCE_USER='${REPLICATION_USER}', SOURCE_PASSWORD='$REPLICA_PASSWORD', SOURCE_AUTO_POSITION=1, GET_SOURCE_PUBLIC_KEY=1, SOURCE_SSL=$REPLICA_SSL; START REPLICA;"
L -e "SET PERSIST super_read_only = ON"`,
  );
}

/** The same for MariaDB: users come along (keeping the replica's own health check login). */
function mariadbInitScript(dataDir: string) {
  return copyScript(
    dataDir,
    `export MYSQL_PWD="$MARIADB_ROOT_PASSWORD"
L() { mariadb --protocol=socket -uroot "$@"; }
STEP="Could not reach the database at $PRIMARY_HOST"
echo "Waiting for $PRIMARY_HOST" >&3
n=0; until mariadb-admin ping -h "$PRIMARY_HOST" -uroot --silent 2>/dev/null; do n=$((n+1)); [ $n -lt 150 ] || exit 1; sleep 2; done
STEP="Could not copy the database"
echo "Copying the database from $PRIMARY_HOST" >&3
# The database's health check login keeps its own password here: the replica's check uses its own.
mariadb-dump -h "$PRIMARY_HOST" -uroot --all-databases --ignore-database=mysql --system=users --insert-ignore --single-transaction --gtid --master-data=1 --routines --events --triggers \\
  | grep -v -E '^(CREATE USER|GRANT|/\\*M!100005 SET DEFAULT ROLE|/\\*!80001 ALTER USER).*.healthcheck.@' | L
STEP="Could not start following the database"
L -e "FLUSH PRIVILEGES; CHANGE MASTER TO MASTER_HOST='$PRIMARY_HOST', MASTER_PORT=3306, MASTER_USER='${REPLICATION_USER}', MASTER_PASSWORD='$REPLICA_PASSWORD', MASTER_USE_GTID=slave_pos, MASTER_SSL=$REPLICA_SSL; START SLAVE;"
# Read-only lets users with READ ONLY ADMIN write (root has it): not on this copy. Replication itself
# is not affected. Root's rights are kept aside first, to give back if this copy becomes the database.
STEP="Could not make the replica read-only"
L -N -e "SELECT Host, Priv FROM mysql.global_priv WHERE User = 'root'" > ${dataDir}/${ROOT_RIGHTS_FILE}
for account in "'root'@'%'" "'root'@'localhost'"; do L -e "SET sql_log_bin = 0; REVOKE READ_ONLY ADMIN ON *.* FROM $account;" 2>/dev/null || true; done`,
  );
}

/**
 * A replica's container: the database's image, settings and TLS (from its plan for the replica's
 * server), with what makes it a replica added, and without the database's own init scripts.
 */
export function replicaSpec(service: Service, id: string, server: ServerCtx, replicaPassword: string, domainCert: DomainCert | null): ReplicaSpec {
  const cfg = service.database!;
  const engine = engines[cfg.engine];
  const password = decryptOrNull(cfg.password) ?? "";
  const dir = server.paths.service(service.id);
  const plan: DatabasePlan = databasePlan(cfg, password, dir, domainCert);
  const initDir = path.posix.join(dir, "initdb");
  const files = plan.files.filter((f) => !f.path.startsWith(`${initDir}/`));
  const binds = plan.binds.filter((b) => !b.startsWith(`${initDir}:`));
  const env = { ...plan.env };
  const base = plan.cmd ?? [...(engine.server ?? []), ...(engine.command?.(plan.creds) ?? [])];
  const tls = plan.tls;
  const primary = service.slug;
  const n = Number(id) || 1;
  let cmd: string[] = base;
  let healthcheck = plan.healthcheck;

  if (cfg.engine === "redis" || cfg.engine === "valkey") {
    cmd = [...base, "--replicaof", primary, String(engine.port), "--masterauth", password, "--replica-read-only", "yes", ...(tls ? ["--tls-replication", "yes"] : [])];
  } else if (cfg.engine === "mysql" || cfg.engine === "mariadb") {
    // Its first start (an empty data directory) copies the database: an init script of its own.
    const replicaInit = path.posix.join(dir, `replica-${id}-init`);
    files.push({
      path: path.posix.join(replicaInit, "serve-replica.sh"),
      content: cfg.engine === "mysql" ? mysqlInitScript(plan.dataMountPath) : mariadbInitScript(plan.dataMountPath),
      mode: 0o755,
    });
    binds.push(`${replicaInit}:/docker-entrypoint-initdb.d:ro`);
    Object.assign(env, { PRIMARY_HOST: primary, REPLICA_PASSWORD: replicationPassword(cfg.engine, replicaPassword), REPLICA_SSL: tls ? "1" : "0" });
    const args =
      cfg.engine === "mysql"
        ? [`--server-id=${1000 + n}`, "--read-only=ON", "--gtid-mode=ON", "--enforce-gtid-consistency=ON", "--relay-log=relay-bin"]
        : [`--server-id=${1000 + n}`, "--read-only=ON", "--log-bin=mysql-bin", "--binlog-format=ROW", "--relay-log=relay-bin"];
    cmd = retryCopyWrapper(plan.dataMountPath, base.length ? [...base, ...args] : [...(engine.server ?? []), ...args]);
    // The copy brings the database's own health check login along, with its password: root checks instead.
    if (cfg.engine === "mariadb") healthcheck = ["CMD-SHELL", `MYSQL_PWD=${sh(password)} mariadb-admin ping -h 127.0.0.1 -uroot --silent`];
  } else if (cfg.engine === "mongodb") {
    // A new member starts empty and copies the set's data itself: no first user of its own.
    delete env.MONGO_INITDB_ROOT_USERNAME;
    delete env.MONGO_INITDB_ROOT_PASSWORD;
    delete env.MONGO_INITDB_DATABASE;
  }
  if (!cmd.length) throw new Error(`${engine.label} replicas need the database's start command.`);
  return { image: plan.image, env, cmd, healthcheck, binds, files, dataMountPath: plan.dataMountPath, publicTarget: plan.publicTarget };
}

/** The database's TLS files on a replica's server too (its plan binds them from there). */
export async function copyTlsFiles(home: ServerCtx, server: ServerCtx, serviceId: string) {
  if (server.id === home.id) return;
  for (const [file, mode] of [
    ["ca.crt", 0o644],
    ["server.crt", 0o644],
    ["server.key", 0o600],
    ["server.pem", 0o600],
  ] as const) {
    const content = await home.fs.readFile(path.posix.join(tlsDir(home, serviceId), file)).catch(() => null);
    if (content !== null) await server.fs.writeFile(path.posix.join(tlsDir(server, serviceId), file), content, mode);
  }
}

export type FollowState = { state: "copying" | "following" | "failed"; lagSeconds: number | null; error?: string | null };

/** How a running replica (not PostgreSQL) is doing, asked inside its container (MongoDB: of the database). */
export async function replicaFollowState(service: Service, docker: Docker, containerId: string, member: string, primaryDocker: Docker | null): Promise<FollowState> {
  const cfg = service.database!;
  const password = decryptOrNull(cfg.password) ?? "";
  if (cfg.engine === "mysql" || cfg.engine === "mariadb") {
    const out = await execCommand(containerId, `${mysqlClient(cfg.engine, password).replace(" -N -B", "")} -h 127.0.0.1 -e 'SHOW REPLICA STATUS\\G'`, {
      docker,
      timeoutSeconds: 20,
    }).catch(() => null);
    // Not answering yet: the first start is still copying the database.
    // Not answering, or not following yet: still copying, or its last copy failed (and it tries again).
    if (out?.exitCode !== 0 || !out.output.trim()) {
      const failed = await execCommand(containerId, `cat ${COPY_ERROR} 2>/dev/null`, { docker, timeoutSeconds: 10 }).catch(() => null);
      const error = failed?.exitCode === 0 ? failed.output.trim() : "";
      return error ? { state: "failed", lagSeconds: null, error: `${error} Trying again.` } : { state: "copying", lagSeconds: null };
    }
    const field = (name: string) => out.output.match(new RegExp(`^\\s*${name}:\\s*(.*)$`, "m"))?.[1]?.trim() ?? "";
    const io = field("Replica_IO_Running") || field("Slave_IO_Running");
    const sql = field("Replica_SQL_Running") || field("Slave_SQL_Running");
    const lag = field("Seconds_Behind_Source") || field("Seconds_Behind_Master");
    const error = field("Last_IO_Error") || field("Last_SQL_Error");
    if (io === "Yes" && sql === "Yes") return { state: "following", lagSeconds: Number(lag) || 0 };
    if (io === "Connecting" && sql === "Yes") return { state: "copying", lagSeconds: null, error: error || null };
    return { state: "failed", lagSeconds: null, error: error || "Replication stopped." };
  }
  if (cfg.engine === "redis" || cfg.engine === "valkey") {
    const bin = cfg.engine === "valkey" ? "valkey-cli" : "redis-cli";
    const tls = cfg.tls?.enabled ? " --tls --insecure" : "";
    const out = await execCommand(containerId, `REDISCLI_AUTH=${sh(password)} VALKEYCLI_AUTH=${sh(password)} ${bin} --no-auth-warning${tls} INFO replication`, {
      docker,
      timeoutSeconds: 20,
    }).catch(() => null);
    if (out?.exitCode !== 0) return { state: "copying", lagSeconds: null };
    const field = (name: string) => out.output.match(new RegExp(`^${name}:(.*)$`, "m"))?.[1]?.trim() ?? "";
    if (field("master_link_status") !== "up" || field("master_sync_in_progress") === "1") return { state: "copying", lagSeconds: null };
    const behind = Number(field("master_last_io_seconds_ago")) || 0;
    // Its offset matches the database's (as far as it last heard): up to date.
    return { state: "following", lagSeconds: field("slave_read_repl_offset") === field("master_repl_offset") ? 0 : behind };
  }
  if (cfg.engine === "mongodb" && primaryDocker) {
    const script = `
let s;
try { s = db.adminCommand({ replSetGetStatus: 1 }); } catch (e) { s = {}; }
const me = (s.members || []).find((m) => m.name === ${JSON.stringify(member)});
const primary = (s.members || []).find((m) => m.stateStr === "PRIMARY");
print(JSON.stringify(me ? { state: me.stateStr, lag: primary && me.optimeDate ? Math.max(0, Math.round((primary.optimeDate - me.optimeDate) / 1000)) : null, error: me.lastHeartbeatMessage || null } : null));`;
    const container = await databaseContainer(primaryDocker, service).catch(() => null);
    if (!container) return { state: "failed", lagSeconds: null, error: "The database is not running." };
    const out = await execCommand(container.id, mongoEval(cfg, password, script), { docker: primaryDocker, timeoutSeconds: 20 }).catch(() => null);
    const info = out?.exitCode === 0 ? (JSON.parse(out.output.trim().split("\n").pop() || "null") as { state: string; lag: number | null; error: string | null } | null) : null;
    if (!info) return { state: "copying", lagSeconds: null };
    if (info.state === "SECONDARY") return { state: "following", lagSeconds: info.lag ?? 0 };
    if (["STARTUP", "STARTUP2", "RECOVERING"].includes(info.state)) return { state: "copying", lagSeconds: null };
    return { state: "failed", lagSeconds: null, error: info.error || `The replica set reports it as ${info.state.toLowerCase()}.` };
  }
  return { state: "copying", lagSeconds: null };
}

/** Removes a replica from the database's side (MongoDB: from the replica set). Others need nothing there. */
export async function forgetReplica(service: Service, docker: Docker, member: string) {
  if (service.database?.engine !== "mongodb") return;
  await primaryMongo(
    service,
    docker,
    `let conf;
try { conf = db.adminCommand({ replSetGetConfig: 1 }).config; } catch (e) { conf = null; }
if (conf && conf.members.some((m) => m.host === ${JSON.stringify(member)})) {
  conf.members = conf.members.filter((m) => m.host !== ${JSON.stringify(member)});
  conf.version++;
  const res = db.adminCommand({ replSetReconfig: conf });
  if (!res.ok) throw new Error(res.errmsg);
}`,
    "Could not remove the replica from the replica set",
  );
}

/**
 * Before a replica's data becomes the database's (MySQL): it stops being read-only for good. Run in
 * the replica while it still runs; the rest (forgetting the database it followed) happens when the
 * new database starts. Other engines need nothing here.
 */
export async function releaseReplica(service: Service, docker: Docker, containerId: string) {
  const cfg = service.database!;
  if (cfg.engine !== "mysql") return;
  const password = decryptOrNull(cfg.password) ?? "";
  await exec(
    docker,
    containerId,
    `${mysqlClient("mysql", password)} -h 127.0.0.1 -e ${sh("STOP REPLICA; RESET PERSIST IF EXISTS super_read_only;")}`,
    "Could not stop the replica",
    password,
  );
}
