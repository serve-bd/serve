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
import { defaultRuntime, type DatabaseConfig, type ReplicaInstance, replicaInstances, replicasSupported } from "@/server/services/types";
import { engines } from "./engines";
import { copyTlsFiles, forgetReplica, mongoMember, preparePrimary, releaseReplica, replicaFollowState, replicaSpec } from "./replica-engines";
import { eq } from "drizzle-orm";
import { databaseContainer } from "./container";
import { databasePlan, TLS_SOURCE } from "./options";
import { POOLER_ROLE, POOLER_SCRIPT, REPLICA_ROLE, REPLICA_SCRIPT } from "./addon-scripts";
import { ensureClientAuth, ensureDatabaseTls, tlsDir } from "./tls";
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

/** The last line a container wrote, for a replica that keeps stopping: what to tell about it. */
async function lastLogLine(docker: Docker, id: string) {
  const raw = await docker
    .getContainer(id)
    .logs({ stdout: true, stderr: true, tail: 20 })
    .catch(() => null);
  if (!raw) return null;
  // Docker's log frames: an 8 byte header before each chunk.
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
  const lines: string[] = [];
  for (let i = 0; i + 8 <= buf.length; ) {
    const size = buf.readUInt32BE(i + 4);
    lines.push(
      ...buf
        .subarray(i + 8, i + 8 + size)
        .toString("utf8")
        .split("\n"),
    );
    i += 8 + size;
  }
  const line = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!line) return null;
  // MongoDB logs JSON lines: the message is what matters.
  try {
    const json = JSON.parse(line) as { msg?: string };
    if (json.msg) return json.msg.slice(0, 300);
  } catch {}
  return line.slice(0, 300);
}

/** The version a replica was copied for: its image tag, kept in its environment (older replicas: their image). */
function copiedFor(container: { Config: { Image: string; Env?: string[] | null } } | null) {
  if (!container) return null;
  const noted = container.Config.Env?.find((e) => e.startsWith("SERVE_IMAGE="))?.slice("SERVE_IMAGE=".length);
  // Pinned by digest with no note: the version is not known, so it is not taken as changed (a copy is costly).
  return noted ?? (container.Config.Image.includes("@") ? null : container.Config.Image);
}

/**
 * The exact image the database runs, by digest: a tag like mongo:8 can point at another version on a
 * server that pulled it later, and a replica must run the database's own version.
 */
async function pinnedImage(home: ServerCtx, image: string) {
  const info = await home.docker
    .getImage(image)
    .inspect()
    .catch(() => null);
  const repo = image.replace(/@.*$/, "").replace(/:[^/]*$/, "");
  const digest = info?.RepoDigests?.find((d) => d.replace(/^docker\.io\/(library\/)?/, "").startsWith(`${repo.replace(/^docker\.io\/(library\/)?/, "")}@`));
  return digest ?? image;
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

/**
 * PostgreSQL allows 10 replication connections and 10 slots by default. More replicas than that
 * need higher limits, which only a restart applies: the database restarts once, when it is needed.
 * Room is kept for the copy a new replica starts with and for slots made outside Serve.
 */
async function ensureReplicationRoom(service: Service, docker: Docker, replicas: number, log: (l: string) => void) {
  const row = await runSql(
    service,
    docker,
    "SELECT current_setting('max_wal_senders') || ' ' || current_setting('max_replication_slots') || ' ' || (SELECT count(*) FROM pg_replication_slots WHERE slot_name NOT LIKE 'serve_replica_%');",
    "Could not read the replication limits",
  );
  const [senders, slots, others] = row.split(/\s+/).map(Number);
  const needSenders = Math.max(10, replicas + 5);
  const needSlots = Math.max(10, replicas + others + 5);
  if (senders >= needSenders && slots >= needSlots) return;
  log(`Raising the replication limits for ${replicas} replicas: the database restarts once`);
  await runSql(
    service,
    docker,
    `ALTER SYSTEM SET max_wal_senders = ${Math.max(senders, needSenders)};\nALTER SYSTEM SET max_replication_slots = ${Math.max(slots, needSlots)};`,
    "Could not raise the replication limits",
  );
  const container = await databaseContainer(docker, service);
  await docker.getContainer(container.id).restart({ t: 30 });
  for (let i = 0; ; i++) {
    const ready = await runSql(service, docker, "SELECT 1;", "not ready").then(
      () => true,
      () => false,
    );
    if (ready) break;
    if (i >= 60) throw new Error("The database did not come back after raising the replication limits.");
    await new Promise((r) => setTimeout(r, 2000));
  }
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
  if (cfg && cfg.engine !== "postgres" && replicasSupported(cfg.engine)) return ensureOtherReplicas(service, instances, log);
  if (cfg?.engine !== "postgres" || !instances.length) return;
  const home = await serverOf(service);
  let password = decryptOrNull(cfg.replica?.password ?? "") ?? "";
  if (!password) {
    password = newPassword();
    await saveConfig(service.id, { replica: { ...cfg.replica!, password: encrypt(password) } });
  }
  await ensureReplicationRoom(service, home.docker, instances.length, log);
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
  const tag = plan.image;
  plan.image = await pinnedImage(home, tag);
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
    // A new replica, or one copied again: its first start copies the database.
    const kept = await d
      .getVolume(dataVolume)
      .inspect()
      .then(() => true)
      .catch(() => false);
    const fresh = !kept || (!!current && copiedFor(current) !== null && copiedFor(current) !== tag);
    if (current && copiedFor(current) !== null && copiedFor(current) !== tag) {
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
          SERVE_IMAGE: tag,
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
    log(`Read replica ${r.id} starting on ${server.row.name} at ${replicaHost(service, r.id)}:5432.${fresh ? " Its first start copies the database." : ""}`);
  }
}

/**
 * MySQL, MariaDB, MongoDB, Redis and Valkey: the database prepared (also with no replicas left, to
 * tidy its side), then each replica started on its server from the database's own settings.
 */
async function ensureOtherReplicas(service: Service, instances: ReplicaInstance[], log: (l: string) => void) {
  const cfg = service.database!;
  // Never had replicas: nothing to set up or tidy.
  if (!instances.length && !cfg.replica) return;
  const home = await serverOf(service);
  let password = decryptOrNull(cfg.replica?.password ?? "") ?? "";
  if (!password && instances.length) {
    password = newPassword();
    await saveConfig(service.id, { replica: { ...cfg.replica!, password: encrypt(password) } });
  }
  if ((cfg.engine === "mariadb" || cfg.engine === "mongodb") && instances.length && !cfg.replica?.primed)
    throw new Error("The database must restart once to be ready for replicas: redeploy it.");
  // MongoDB over TLS: members present the database's certificate to each other, as clients too.
  if (cfg.engine === "mongodb" && cfg.tls?.enabled && instances.length && (await ensureClientAuth(home, service.id, log))) {
    const container = await databaseContainer(home.docker, service);
    await home.docker.getContainer(container.id).restart({ t: 30 });
    for (let i = 0; i < 60; i++) {
      const info = await home.docker.getContainer(container.id).inspect();
      if (info.State.Health?.Status === "healthy") break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await preparePrimary(
    service,
    home.docker,
    instances.map((r) => mongoMember(replicaHost(service, r.id))),
    password,
    log,
  );
  if (!instances.length) return;
  const engine = engines[cfg.engine];
  const [project] = await db.select({ organizationId: schema.project.organizationId }).from(schema.project).where(eq(schema.project.id, service.projectId));
  const { meshBeforeStart, meshAfterStart } = await import("@/server/mesh");
  for (const r of instances) {
    const server = r.serverId === home.id ? home : await getServer(r.serverId);
    const d = server.docker;
    const name = replicaName(service, r.id);
    const dataVolume = volumeName(service.slug, `replica-${r.id}-data`);
    // Public access: the shared port on this replica's server, with the domain's certificate when TLS is on.
    const pub = cfg.replica?.public?.port ? cfg.replica.public : null;
    const cert = pub?.domain && cfg.tls?.enabled && project ? await activeCertMount(server, project.organizationId, pub.domain) : null;
    if (pub?.domain && cfg.tls?.enabled && !cert) log(`No certificate for ${pub.domain} on ${server.row.name} yet: Serve's own certificate is used until it is issued.`);
    const spec = replicaSpec(service, r.id, server, password, cert);
    const tag = spec.image;
    spec.image = await pinnedImage(home, tag);
    spec.env.SERVE_IMAGE = tag;
    // A replica runs the database's own version: after a version change it is copied again.
    const current = await d
      .getContainer(name)
      .inspect()
      .catch(() => null);
    // Copied again only for another version of the database (its tag), not for a newer build of the same one.
    // A new replica, or one copied again: its first start copies the database.
    const kept = await d
      .getVolume(dataVolume)
      .inspect()
      .then(() => true)
      .catch(() => false);
    const fresh = !kept || (!!current && copiedFor(current) !== null && copiedFor(current) !== tag);
    if (current && copiedFor(current) !== null && copiedFor(current) !== tag) {
      log(`Replica ${r.id}: the database's version changed, copying it again`);
      await removeContainer(name, 30, d);
      await d
        .getVolume(dataVolume)
        .remove()
        .catch(() => {});
    }
    if (cfg.tls?.enabled) await copyTlsFiles(home, server, service.id);
    for (const f of spec.files) await server.fs.writeFile(f.path, f.content, f.mode);
    await ensureImage(server, spec.image, log);
    const network = await ensureEnvNetwork(service.environmentId, server);
    // On another server, the database's name answers there once the private network has it.
    if (server.id !== home.id) await meshBeforeStart(service, server.id, log);
    await removeContainer(name, 30, d);
    await startContainer(
      {
        name,
        image: spec.image,
        slug: service.slug,
        serviceId: service.id,
        kind: `replica-${r.id}`,
        env: spec.env,
        extraBinds: spec.binds,
        cmd: spec.cmd,
        healthcheck: spec.healthcheck,
        healthTiming: { interval: 10, timeout: 5, retries: 6, startPeriod: 600 },
        runtime: {
          ...defaultRuntime(engine.port),
          restartPolicy: "unless-stopped",
          volumes: [{ kind: "volume", source: `replica-${r.id}-data`, mountPath: spec.dataMountPath }],
          ports: pub ? [{ host: pub.port!, container: spec.publicTarget, protocol: "tcp", bindAddress: pub.bind }] : [],
        },
        aliases: [name, replicaHost(service, r.id), replicaHost(service)],
        network,
      },
      server,
    );
    await meshAfterStart(server.id, log);
    log(`Read replica ${r.id} starting on ${server.row.name} at ${replicaHost(service, r.id)}:${engine.port}.${fresh ? " Its first start copies the database." : ""}`);
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
  if (service.database?.engine !== "postgres") {
    await forgetReplica(service, home.docker, mongoMember(replicaHost(service, r.id))).catch(() => null);
    return;
  }
  await runSql(
    service,
    home.docker,
    `SELECT pg_drop_replication_slot('${replicaSlot(r.id)}') WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = '${replicaSlot(r.id)}' AND NOT active);`,
    "Could not remove the replication slot",
  ).catch(() => null);
}

export type ReplicaState = { id: string; serverId: string; state: "copying" | "following" | "stopped" | "failed"; lagSeconds: number | null; error?: string | null };

/** How each replica is doing: still copying, following (and how far behind), or not running. */
export async function replicaStatuses(service: Service): Promise<ReplicaState[]> {
  const instances = replicaInstances(service);
  if (!instances.length) return [];
  const home = await serverOf(service);
  if (service.database?.engine !== "postgres") {
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
        if (info.State.Restarting || (!info.State.Running && info.State.ExitCode))
          return { ...r, state: "failed", lagSeconds: null, error: await lastLogLine(server!.docker, info.Id) };
        if (!info.State.Running) return { ...r, state: "stopped", lagSeconds: null };
        const follow = await replicaFollowState(service, server!.docker, info.Id, mongoMember(replicaHost(service, r.id)), home.docker);
        return { ...r, ...follow };
      }),
    );
  }
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
      if (info.State.Restarting || (!info.State.Running && info.State.ExitCode))
        return { ...r, state: "failed", lagSeconds: null, error: await lastLogLine(server!.docker, info.Id) };
      if (!info.State.Running) return { ...r, state: "stopped", lagSeconds: null };
      const lag = lags.get(replicaSlot(r.id));
      return lag === undefined ? { ...r, state: "copying", lagSeconds: null } : { ...r, state: "following", lagSeconds: lag };
    }),
  );
}

/**
 * Makes a replica the database: for when the database's server is lost. The database's container
 * (when its server still answers) and the replica's stop; the replica's copy, no longer a standby,
 * becomes the database's data on the replica's server, and the database deploys there on it. The
 * old data stays in its volume. Other replicas copy the new database again.
 */
export async function promoteReplica(service: Service, id: string, log: (l: string) => void = () => {}) {
  const cfg = service.database!;
  const instances = replicaInstances(service);
  const r = instances.find((x) => x.id === id);
  if (!r) throw new Error("That replica is gone.");
  // The old database stops first, if its server answers: two writable copies must never run.
  const home = await serverOf(service).catch(() => null);
  if (home) {
    await removeContainer(service.slug, 30, home.docker);
    await removeContainer(poolerName(service), 10, home.docker);
    // removeContainer keeps its errors to itself: the old database must be gone, not only asked to
    // go, before the replica takes writes. A container left (even stopped: Docker may start it
    // again) or a server that stops answering now stops the promotion with nothing changed.
    const gone = await home.docker
      .getContainer(service.slug)
      .inspect()
      .then(
        () => false,
        (e: { statusCode?: number; message?: string }) => {
          if (e.statusCode === 404) return true;
          throw new Error(`Could not check that ${service.name} stopped on ${home.row.name} (${e.message ?? e}). Nothing was changed; try again.`);
        },
      );
    if (!gone)
      throw new Error(
        `${service.name} could not be removed on ${home.row.name}, so the replica was not promoted: two writable copies must never run. Nothing was changed; stop it there and try again.`,
      );
    log(`Stopped ${service.name} on ${home.row.name}`);
  } else log("The database's server does not answer: promoting without stopping it. Do not start it again.");
  const server = await getServer(r.serverId);
  if (cfg.engine !== "postgres") {
    // MySQL: read-only no more. The rest (forgetting the database it followed, MongoDB's replica
    // set with it as primary) is done when it starts as the database.
    const running = await server.docker
      .getContainer(replicaName(service, r.id))
      .inspect()
      .catch(() => null);
    if (running?.State.Running) await releaseReplica(service, server.docker, running.Id).catch((e: Error) => log(`Warning: ${e.message}`));
  }
  await removeContainer(replicaName(service, r.id), 30, server.docker);
  const data = volumeName(service.slug, `replica-${r.id}-data`);
  if (cfg.engine !== "postgres") return finishPromotion(service, r, server, data, instances, log);
  // Out of standby: its data opens as the database's own.
  const plan = databasePlan(cfg, decryptOrNull(cfg.password) ?? "", server.paths.service(service.id), null);
  const pgdata = plan.env.PGDATA ?? plan.dataMountPath;
  const rel = pgdata.startsWith(plan.dataMountPath) ? pgdata.slice(plan.dataMountPath.length).replace(/^\/+/, "") : "";
  await ensureImage(server, "alpine:3.22.6", log);
  const helper = await server.docker.createContainer({
    Image: "alpine:3.22.6",
    Cmd: ["rm", "-f", `/data/${rel ? `${rel}/` : ""}standby.signal`],
    Labels: { [LABEL.managed]: "true", [LABEL.kind]: "helper" },
    HostConfig: { Binds: [`${data}:/data`] },
  });
  try {
    await helper.start();
    // A standby.signal left would start it read-only, as a replica of nothing.
    const { StatusCode } = (await helper.wait()) as { StatusCode: number };
    if (StatusCode !== 0) throw new Error(`Could not take replica ${r.id} out of standby (exit ${StatusCode}). Its data is untouched in ${data}.`);
  } finally {
    await helper.remove({ force: true }).catch(() => {});
  }
  return finishPromotion(service, r, server, data, instances, log);
}

/** The replica's data becomes the database's, on its server; the other replicas copy the new database. */
async function finishPromotion(service: Service, r: ReplicaInstance, server: ServerCtx, data: string, instances: ReplicaInstance[], log: (l: string) => void) {
  const cfg = service.database!;
  // The other replicas followed the old database: they copy the new one when it is up.
  const others = instances.filter((x) => x.id !== r.id);
  for (const o of others)
    await removeReplicaInstance(service, o).catch((e: Error) => log(`Warning: replica ${o.id} on its server was not removed (${e.message}); remove its container by hand`));
  await db
    .update(schema.service)
    .set({
      serverId: r.serverId,
      database: {
        ...cfg,
        dataVolume: data,
        dataVolumeOwned: true,
        replica: cfg.replica ? { ...cfg.replica, enabled: others.length > 0, instances: others } : cfg.replica,
      },
      updatedAt: new Date(),
    })
    .where(eq(schema.service.id, service.id));
  log(`Replica ${r.id} is the database now, on ${server.row.name}`);
}
