import crypto from "node:crypto";
import path from "node:path";
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
import { databasePlan, TLS_SOURCE } from "./options";
import { POOLER_ROLE, POOLER_SCRIPT, REPLICA_ROLE, REPLICA_SCRIPT } from "./addon-scripts";
import { ensureDatabaseTls, tlsDir } from "./tls";
import { activeCertMount } from "./domain-tls";

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

/**
 * TLS files for a public pooler or replica on a server: the database's own certificate (from its
 * authority, the one clients may pin), copied from the database's server when the container runs
 * elsewhere, and the domain's certificate when one covers it there. Binds and environment for
 * the container's start step, which copies them into place.
 */
async function publicTls(server: ServerCtx, service: Service, domain: string | null, names: string[], log: (l: string) => void) {
  const home = await serverOf(service);
  await ensureDatabaseTls(home, service.id, [service.slug, privateHost(service), ...names, domain ?? "", home.row.publicIp ?? ""], log);
  if (server.id !== home.id) {
    for (const [file, mode] of [
      ["ca.crt", 0o644],
      ["server.crt", 0o644],
      ["server.key", 0o600],
      ["server.pem", 0o600],
    ] as const) {
      const content = await home.fs.readFile(path.posix.join(tlsDir(home, service.id), file));
      await server.fs.writeFile(path.posix.join(tlsDir(server, service.id), file), content, mode);
    }
  }
  const [project] = await db.select({ organizationId: schema.project.organizationId }).from(schema.project).where(eq(schema.project.id, service.projectId));
  const cert = domain && project ? await activeCertMount(server, project.organizationId, domain) : null;
  if (domain && !cert) log(`No certificate for ${domain} on ${server.row.name} yet: Serve's own certificate is used until it is issued.`);
  return {
    binds: [`${tlsDir(server, service.id)}:${TLS_SOURCE}:ro`, ...(cert?.binds ?? [])],
    env: cert ? { DOMAIN_CERT: cert.cert, DOMAIN_KEY: cert.key } : ({} as Record<string, string>),
  };
}

/* -------------------------------------------------------------------------- */
/*                                   Pooler                                   */
/* -------------------------------------------------------------------------- */

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
  // Public access: TLS with Serve's certificate for the database, or the domain's when there is one.
  const pub = cfg.pooler.public?.port && !cfg.pooler.public.tunnelId ? cfg.pooler.public : null;
  const tls = pub ? await publicTls(server, service, pub.domain ?? null, [poolerHost(service)], log) : null;
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
        ...(tls ? { PUBLIC: "1", ...tls.env } : {}),
      },
      cmd: ["sh", "-c", POOLER_SCRIPT],
      extraBinds: tls?.binds,
      runtime: {
        ...defaultRuntime(5432),
        restartPolicy: "unless-stopped",
        user: "0",
        ports: pub ? [{ host: pub.port!, container: 5432, protocol: "tcp", bindAddress: pub.bind }] : [],
      },
      aliases: [poolerName(service), poolerHost(service)],
      network,
    },
    server,
  );
  log(`Connection pooler running at ${poolerHost(service)}:5432 (${cfg.pooler.mode} pooling, ${cfg.pooler.poolSize} connections per database and login)`);
  if (pub) log(`Public port ${pub.port} (TLS)${pub.domain ? ` for ${pub.domain}` : ""}`);
}

export async function removePooler(service: Service) {
  const server = await serverOf(service);
  await removeContainer(poolerName(service), 10, server.docker);
}

/* -------------------------------------------------------------------------- */
/*                                   Replica                                  */
/* -------------------------------------------------------------------------- */

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
    // Public access: the shared port on this replica's server, with TLS.
    const pub = cfg.replica?.public?.port ? cfg.replica.public : null;
    const tls = pub ? await publicTls(server, service, pub.domain ?? null, [replicaHost(service), replicaHost(service, r.id)], log) : null;
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
          ...(tls ? { PUBLIC: "1", ...tls.env } : {}),
        },
        extraBinds: tls?.binds,
        cmd: ["sh", "-c", REPLICA_SCRIPT],
        // With the database's own login: a check as root fills the log with failed logins.
        healthcheck: ["CMD-SHELL", `pg_isready -q -h 127.0.0.1 -p 5432 -U '${cfg.username.replace(/'/g, "")}' -d postgres`],
        healthTiming: { interval: 10, timeout: 5, retries: 6, startPeriod: 600 },
        runtime: {
          ...defaultRuntime(5432),
          restartPolicy: "unless-stopped",
          volumes: [{ kind: "volume", source: `replica-${r.id}-data`, mountPath: plan.dataMountPath }],
          ports: pub ? [{ host: pub.port!, container: 5432, protocol: "tcp", bindAddress: pub.bind }] : [],
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
