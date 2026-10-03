import crypto from "node:crypto";
import type Docker from "dockerode";
import { decryptOrNull, encrypt } from "@/server/crypto";
import { db, schema } from "@/server/db";
import { imageExists, LABEL, pullImage, removeContainer } from "@/server/docker/client";
import { ensureEnvNetwork } from "@/server/docker/networks";
import { startContainer, volumeName } from "@/server/deploy/containers";
import { privateHost } from "@/lib/hostname";
import { getServer, serverOf, type ServerCtx } from "@/server/servers/context";
import { execCommand } from "@/server/services/exec";
import { defaultRuntime, type DatabaseConfig, replicaInstances } from "@/server/services/types";
import { eq } from "drizzle-orm";
import { databaseContainer } from "./container";
import { databasePlan } from "./options";

/**
 * Add-ons next to a PostgreSQL database service, each in its own container with the service's
 * label (so stopping, starting and deleting the service take them along):
 *   pooler   PgBouncer, at <host>-pooler:5432. Logins are checked against the database itself.
 *   replica  a streaming read-only copy, at <host>-replica:5432, on its own volume.
 * Neither restarts the database or touches its data: the database gets a login (and, for the
 * replica, a replication slot and an access rule), added while it runs.
 */

type Service = typeof schema.service.$inferSelect;

export const POOLER_IMAGE = "edoburu/pgbouncer:v1.25.2-p0";
const POOLER_ROLE = "serve_pooler";
const REPLICA_ROLE = "serve_replicator";
/** One replication slot per replica: what it has not received yet is kept for it alone. */
const replicaSlot = (id: string) => `serve_replica_${id.replace(/[^a-z0-9]/gi, "")}`;
/** WAL the database keeps for a replica that is behind or stopped, so it cannot fill the disk. */
const REPLICA_WAL_LIMIT = "4GB";

export const poolerName = (service: { slug: string }) => `${service.slug}-pooler`;
export const replicaName = (service: { slug: string }, id: string) => `${service.slug}-replica-${id}`;
export const poolerHost = (service: { slug: string; hostname?: string | null }) => `${privateHost(service)}-pooler`;
/** The read name over all replicas, or one replica's own name. */
export const replicaHost = (service: { slug: string; hostname?: string | null }, id?: string) => `${privateHost(service)}-replica${id ? `-${id}` : ""}`;

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const pipeSql = (sql: string) => `printf '%s' '${Buffer.from(sql, "utf8").toString("base64")}' | base64 -d`;
const newPassword = () => crypto.randomBytes(24).toString("hex");

/** Runs SQL in the database's "postgres" database as its main user. */
async function runSql(service: Service, docker: Docker, sql: string, what: string) {
  const cfg = service.database!;
  const container = await databaseContainer(docker, service);
  const password = decryptOrNull(cfg.password) ?? "";
  const res = await execCommand(container.id, `set -e; export PGPASSWORD=${sh(password)}; ${pipeSql(sql)} | psql -X -v ON_ERROR_STOP=1 -q -At -U ${sh(cfg.username)} -d postgres`, {
    docker,
    timeoutSeconds: 60,
  });
  if (res.exitCode !== 0) throw new Error(`${what}: ${res.output.replaceAll(password, "***").trim().split("\n").slice(-2).join(" ")}`);
  return res.output.trim();
}

async function saveConfig(serviceId: string, patch: Partial<DatabaseConfig>) {
  const fresh = await db.query.service.findFirst({ where: eq(schema.service.id, serviceId) });
  if (!fresh?.database) throw new Error("The database is gone.");
  await db
    .update(schema.service)
    .set({ database: { ...fresh.database, ...patch } })
    .where(eq(schema.service.id, serviceId));
}

async function ensureImage(server: ServerCtx, image: string, log: (l: string) => void) {
  if (await imageExists(image, server.docker)) return;
  log(`Pulling ${image}`);
  await pullImage(image, log, null, server.docker);
}

/* -------------------------------------------------------------------------- */
/*                                   Pooler                                   */
/* -------------------------------------------------------------------------- */

/** PgBouncer's configuration, written by the container at start from its environment. */
const POOLER_SCRIPT = `set -e
cat > /etc/pgbouncer/pgbouncer.ini <<EOF
[databases]
* = host=$DB_HOST port=5432 auth_dbname=postgres

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 5432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
auth_user = ${POOLER_ROLE}
auth_query = SELECT usename, passwd FROM ${POOLER_ROLE}.lookup(\\$1)
pool_mode = $POOL_MODE
default_pool_size = $POOL_SIZE
max_client_conn = $MAX_CLIENTS
max_prepared_statements = 200
ignore_startup_parameters = extra_float_digits,options,search_path
server_tls_sslmode = prefer
EOF
printf '"${POOLER_ROLE}" "%s"\\n' "$AUTH_PASSWORD" > /etc/pgbouncer/userlist.txt
exec /usr/bin/pgbouncer /etc/pgbouncer/pgbouncer.ini`;

/** The login PgBouncer uses to look up other logins' password hashes (and nothing else). */
function poolerSetupSql(password: string, owner: string) {
  const ident = `"${owner.replace(/"/g, '""')}"`;
  return `DO $serve$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${POOLER_ROLE}') THEN CREATE ROLE ${POOLER_ROLE} LOGIN; END IF;
END $serve$;
ALTER ROLE ${POOLER_ROLE} WITH LOGIN PASSWORD '${password}';
CREATE SCHEMA IF NOT EXISTS ${POOLER_ROLE} AUTHORIZATION ${ident};
CREATE OR REPLACE FUNCTION ${POOLER_ROLE}.lookup(p_user text) RETURNS TABLE (usename name, passwd text)
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
  AS $fn$ SELECT usename, passwd FROM pg_catalog.pg_shadow WHERE usename = p_user $fn$;
REVOKE ALL ON FUNCTION ${POOLER_ROLE}.lookup(text) FROM PUBLIC;
GRANT USAGE ON SCHEMA ${POOLER_ROLE} TO ${POOLER_ROLE};
GRANT EXECUTE ON FUNCTION ${POOLER_ROLE}.lookup(text) TO ${POOLER_ROLE};`;
}

/** Starts (or restarts with new settings) the pooler of a running PostgreSQL database. */
export async function ensurePooler(service: Service, log: (l: string) => void = () => {}) {
  const cfg = service.database;
  if (cfg?.engine !== "postgres" || !cfg.pooler?.enabled) return;
  const server = await serverOf(service);
  let password = decryptOrNull(cfg.pooler.password ?? "") ?? "";
  if (!password) {
    password = newPassword();
    await saveConfig(service.id, { pooler: { ...cfg.pooler, password: encrypt(password) } });
  }
  await runSql(service, server.docker, poolerSetupSql(password, cfg.username), "Could not set up the pooler's login");
  await ensureImage(server, POOLER_IMAGE, log);
  const network = await ensureEnvNetwork(service.environmentId, server);
  await removeContainer(poolerName(service), 10, server.docker);
  await startContainer(
    {
      name: poolerName(service),
      image: POOLER_IMAGE,
      slug: service.slug,
      serviceId: service.id,
      kind: "pooler",
      env: {
        DB_HOST: service.slug,
        POOL_MODE: cfg.pooler.mode,
        POOL_SIZE: String(cfg.pooler.poolSize),
        MAX_CLIENTS: String(cfg.pooler.maxClients),
        AUTH_PASSWORD: password,
      },
      cmd: ["sh", "-c", POOLER_SCRIPT],
      runtime: { ...defaultRuntime(5432), restartPolicy: "unless-stopped" },
      aliases: [poolerName(service), poolerHost(service)],
      network,
    },
    server,
  );
  log(`Connection pooler running at ${poolerHost(service)}:5432 (${cfg.pooler.mode} pooling, ${cfg.pooler.poolSize} connections per database and login)`);
}

export async function removePooler(service: Service) {
  const server = await serverOf(service);
  await removeContainer(poolerName(service), 10, server.docker);
}

/* -------------------------------------------------------------------------- */
/*                                   Replica                                  */
/* -------------------------------------------------------------------------- */

/**
 * A replica's start: copy the database once (pg_basebackup over its replication slot), then run
 * as a hot standby that follows it. Runs as root, like the image's own entrypoint.
 */
const REPLICA_SCRIPT = `set -e
D="\${PGDATA:-/var/lib/postgresql/data}"
AS="$(command -v gosu || command -v su-exec)"
if [ ! -s "$D/PG_VERSION" ]; then
  mkdir -p "$D" && chown -R postgres:postgres "$D" && chmod 700 "$D"
  echo "Waiting for $PRIMARY_HOST"
  until "$AS" postgres pg_isready -q -h "$PRIMARY_HOST" -p 5432; do sleep 2; done
  echo "Copying the database from $PRIMARY_HOST"
  "$AS" postgres env PGPASSWORD="$REPLICA_PASSWORD" pg_basebackup -h "$PRIMARY_HOST" -p 5432 -U ${REPLICA_ROLE} -D "$D" -X stream -S "$REPLICA_SLOT" -R -P
  echo "Copy finished"
fi
touch "$D/standby.signal" && chown postgres:postgres "$D/standby.signal"
exec "$AS" postgres postgres -c hot_standby=on -c "primary_slot_name=$REPLICA_SLOT" \\
  -c "primary_conninfo=host=$PRIMARY_HOST port=5432 user=${REPLICA_ROLE} password=$REPLICA_PASSWORD application_name=$REPLICA_SLOT"`;

/** The database's side: a replication login, a slot per replica (with a cap on what they keep) and an access rule. Applied while it runs. */
function primarySetupSql(password: string, slots: string[]) {
  return `DO $serve$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${REPLICA_ROLE}') THEN CREATE ROLE ${REPLICA_ROLE} WITH REPLICATION LOGIN; END IF;
END $serve$;
ALTER ROLE ${REPLICA_ROLE} WITH REPLICATION LOGIN PASSWORD '${password}';
${slots.map((slot) => `SELECT pg_create_physical_replication_slot('${slot}') WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = '${slot}');`).join("\n")}
ALTER SYSTEM SET max_slot_wal_keep_size = '${REPLICA_WAL_LIMIT}';
SELECT pg_reload_conf();`;
}

async function allowReplication(service: Service, docker: Docker) {
  const cfg = service.database!;
  const container = await databaseContainer(docker, service);
  const password = decryptOrNull(cfg.password) ?? "";
  const rule = `host replication ${REPLICA_ROLE} all scram-sha-256`;
  const res = await execCommand(
    container.id,
    `set -e; export PGPASSWORD=${sh(password)}; HBA=$(psql -X -At -U ${sh(cfg.username)} -d postgres -c 'SHOW hba_file'); grep -qF ${sh(rule)} "$HBA" || printf '\\n%s\\n' ${sh(rule)} >> "$HBA"; psql -X -q -At -U ${sh(cfg.username)} -d postgres -c 'SELECT pg_reload_conf()' >/dev/null`,
    { docker, timeoutSeconds: 30 },
  );
  if (res.exitCode !== 0) throw new Error(`Could not allow replication: ${res.output.replaceAll(password, "***").trim().split("\n").slice(-2).join(" ")}`);
}

/**
 * Starts the read replicas of a running PostgreSQL database, each on its server, copying the
 * database first into a replica whose volume is empty. A replica on another server reaches the
 * database over the private network.
 */
export async function ensureReplicas(service: Service, log: (l: string) => void = () => {}) {
  const cfg = service.database;
  const instances = replicaInstances(service);
  if (cfg?.engine !== "postgres" || !instances.length) return;
  const home = await serverOf(service);
  let password = decryptOrNull(cfg.replica?.password ?? "") ?? "";
  if (!password) {
    password = newPassword();
    await saveConfig(service.id, { replica: { ...cfg.replica!, password: encrypt(password) } });
  }
  await runSql(
    service,
    home.docker,
    primarySetupSql(
      password,
      instances.map((r) => replicaSlot(r.id)),
    ),
    "Could not prepare the database for replicas",
  );
  await allowReplication(service, home.docker);
  // The single replica of the first version (one container named <slug>-replica): replaced by replica 1.
  await removeContainer(`${service.slug}-replica`, 30, home.docker);
  await home.docker
    .getVolume(volumeName(service.slug, "replica-data"))
    .remove()
    .catch(() => {});

  const plan = databasePlan(cfg, decryptOrNull(cfg.password) ?? "", home.paths.service(service.id), null);
  const { meshBeforeStart, meshAfterStart } = await import("@/server/mesh");
  for (const r of instances) {
    const server = r.serverId === home.id ? home : await getServer(r.serverId);
    const d = server.docker;
    const name = replicaName(service, r.id);
    const dataVolume = volumeName(service.slug, `replica-${r.id}-data`);
    // A replica runs the database's own version: after a major version change it is copied again.
    const current = await d
      .getContainer(name)
      .inspect()
      .catch(() => null);
    if (current && current.Config.Image !== plan.image) {
      log(`Replica ${r.id}: the database's version changed, copying it again`);
      await removeContainer(name, 30, d);
      await d
        .getVolume(dataVolume)
        .remove()
        .catch(() => {});
    }
    await ensureImage(server, plan.image, log);
    const network = await ensureEnvNetwork(service.environmentId, server);
    // On another server, the database's name answers there once the private network has it.
    if (server.id !== home.id) await meshBeforeStart(service, server.id, log);
    await removeContainer(name, 30, d);
    await startContainer(
      {
        name,
        image: plan.image,
        slug: service.slug,
        serviceId: service.id,
        kind: `replica-${r.id}`,
        env: {
          ...(plan.env.PGDATA ? { PGDATA: plan.env.PGDATA } : {}),
          PRIMARY_HOST: service.slug,
          REPLICA_PASSWORD: password,
          REPLICA_SLOT: replicaSlot(r.id),
        },
        cmd: ["sh", "-c", REPLICA_SCRIPT],
        healthcheck: ["CMD-SHELL", "pg_isready -q -h 127.0.0.1 -p 5432"],
        healthTiming: { interval: 10, timeout: 5, retries: 6, startPeriod: 600 },
        runtime: {
          ...defaultRuntime(5432),
          restartPolicy: "unless-stopped",
          volumes: [{ kind: "volume", source: `replica-${r.id}-data`, mountPath: plan.dataMountPath }],
        },
        aliases: [name, replicaHost(service, r.id), replicaHost(service)],
        network,
      },
      server,
    );
    await meshAfterStart(server.id, log);
    log(`Read replica ${r.id} starting on ${server.row.name} at ${replicaHost(service, r.id)}:5432. Its first start copies the database.`);
  }
}

/** Removes one replica: its container and copy on its server, and its slot on the database (so no WAL is kept for it). */
export async function removeReplicaInstance(service: Service, r: { id: string; serverId: string }) {
  const server = await getServer(r.serverId).catch(() => null);
  if (server) {
    await removeContainer(replicaName(service, r.id), 30, server.docker);
    await server.docker
      .getVolume(volumeName(service.slug, `replica-${r.id}-data`))
      .remove()
      .catch(() => {});
  }
  const home = await serverOf(service);
  await runSql(
    service,
    home.docker,
    `SELECT pg_drop_replication_slot('${replicaSlot(r.id)}') WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = '${replicaSlot(r.id)}' AND NOT active);`,
    "Could not remove the replication slot",
  ).catch(() => null);
}

export type ReplicaState = { id: string; serverId: string; state: "copying" | "following" | "stopped" | "failed"; lagSeconds: number | null };

/** How each replica is doing: still copying, following (and how far behind), or not running. */
export async function replicaStatuses(service: Service): Promise<ReplicaState[]> {
  const instances = replicaInstances(service);
  if (!instances.length) return [];
  const home = await serverOf(service);
  // The database's own measure, per replica: how long its changes take to be replayed there.
  const lags = new Map<string, number>();
  const out = await runSql(
    service,
    home.docker,
    // Caught up (replayed all the database wrote) is up to date, whatever the last measured lag was:
    // Postgres keeps that number until the replica next reports, which can be a while after a burst.
    "SELECT application_name || '|' || CASE WHEN replay_lsn >= pg_current_wal_lsn() THEN 0 ELSE COALESCE(EXTRACT(EPOCH FROM replay_lag)::int, 0) END FROM pg_stat_replication WHERE application_name LIKE 'serve_replica_%';",
    "Could not read the replicas' lag",
  ).catch(() => "");
  for (const line of out.split("\n").filter(Boolean)) {
    const [app, lag] = line.split("|");
    lags.set(app, Number(lag) || 0);
  }
  return Promise.all(
    instances.map(async (r): Promise<ReplicaState> => {
      const server = r.serverId === home.id ? home : await getServer(r.serverId).catch(() => null);
      const info = server
        ? await server.docker
            .getContainer(replicaName(service, r.id))
            .inspect()
            .catch(() => null)
        : null;
      if (!info || info.Config.Labels?.[LABEL.service] !== service.id) return { ...r, state: "stopped", lagSeconds: null };
      if (!info.State.Running) return { ...r, state: info.State.ExitCode ? "failed" : "stopped", lagSeconds: null };
      const lag = lags.get(replicaSlot(r.id));
      return lag === undefined ? { ...r, state: "copying", lagSeconds: null } : { ...r, state: "following", lagSeconds: lag };
    }),
  );
}
