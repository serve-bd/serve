import crypto from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type Docker from "dockerode";
import { db, schema } from "@/server/db";
import { LABEL } from "@/server/docker/client";
import { engines } from "@/server/databases/engines";
import { databaseContainer } from "@/server/databases/container";
import { databaseCreds } from "@/server/databases/options";
import { serverOf } from "@/server/servers/context";
import { notify, orgOfService } from "@/server/notify";
import { checkIntegrity, type Commands, execText, localBackupFile, logLine, openBackupFile, restoreWith } from "./index";

/*
 * Backup proof: a backup is restored into a throwaway container of the same database image on the
 * database's server, with no network, and what came back is counted. The backup is marked tested
 * (or failed, with the reason); the container and its data are removed either way.
 */

const KIND = "backup-test";
const READY_MS = 180_000;

/** What the restored copy holds, in a few words, by engine. */
const COUNT: Record<string, (pw: string, database: string, user: string) => string> = {
  postgres: (pw, d, u) =>
    // Every database: a dump of several restores each under its own name.
    `export PGPASSWORD='${pw}'; for db in $(psql -X -Atq -U '${u}' -d '${d}' -c "select datname from pg_database where not datistemplate"); do psql -X -Atq -U '${u}' -d "$db" -c "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')" || exit 1; done | awk '{ n += $1 } END { print n " tables" }'`,
  mysql: (pw) =>
    `MYSQL_PWD='${pw}' mysql -uroot -N -e "select count(*) from information_schema.tables where table_schema not in ('mysql','sys','information_schema','performance_schema')" | sed 's/$/ tables/'`,
  mariadb: (pw) =>
    `MYSQL_PWD='${pw}' mariadb -uroot -N -e "select count(*) from information_schema.tables where table_schema not in ('mysql','sys','information_schema','performance_schema')" | sed 's/$/ tables/'`,
  mongodb: (pw, _d, u) =>
    `mongosh --quiet -u '${u}' -p '${pw}' --authenticationDatabase admin --eval 'let n=0; db.adminCommand({listDatabases:1}).databases.forEach(d=>{ if(!["admin","local","config"].includes(d.name)) n+=db.getSiblingDB(d.name).getCollectionNames().length }); print(n + " collections")'`,
  redis: (pw) => `REDISCLI_AUTH='${pw}' redis-cli DBSIZE | sed 's/$/ keys/'`,
  valkey: (pw) => `REDISCLI_AUTH='${pw}' valkey-cli DBSIZE | sed 's/$/ keys/'`,
  clickhouse: (pw) =>
    `clickhouse-client --password '${pw}' -q "select count() from system.tables where database not in ('system','INFORMATION_SCHEMA','information_schema')" | sed 's/$/ tables/'`,
};

/** Test containers a crash or restart left behind. */
async function sweep(docker: Docker) {
  const old = await docker.listContainers({ all: true, filters: { label: [`${LABEL.kind}=${KIND}`] } }).catch(() => []);
  for (const c of old)
    if (Date.now() / 1000 - c.Created > 3600)
      await docker
        .getContainer(c.Id)
        .remove({ force: true, v: true })
        .catch(() => {});
}

export async function verifyBackup(backupId: string) {
  const backup = await db.query.backup.findFirst({ where: eq(schema.backup.id, backupId), with: { service: true } });
  if (!backup?.filename || backup.status !== "success") throw new Error("Backup not found");
  const service = backup.service;
  const cfg = service.database;
  if (backup.target || !cfg) throw new Error("Only database backups can be tested.");
  const engine = engines[cfg.engine];
  const log = (line: string) => void logLine(backupId, `Test: ${line}`);
  await db.update(schema.backup).set({ verifyStatus: "running", verifyError: null }).where(eq(schema.backup.id, backupId));
  let container: Docker.Container | null = null;
  try {
    const { docker } = await serverOf(service);
    await sweep(docker);
    // The same image the database runs, else the one its version names.
    const live = await databaseContainer(docker, service).catch(() => null);
    const image = (live ? (await live.inspect()).Config.Image : null) ?? `${engine.image}:${cfg.version}`;
    const password = crypto.randomBytes(18).toString("base64url");
    const creds = { ...databaseCreds(cfg, password), tlsRequired: false };
    log(`starting a throwaway ${engine.label} (${image})`);
    container = await docker.createContainer({
      Image: image,
      Env: Object.entries(engine.env(creds)).map(([k, v]) => `${k}=${v}`),
      ...(engine.command?.(creds) ? { Cmd: engine.command(creds) } : {}),
      Labels: { [LABEL.managed]: "true", [LABEL.kind]: KIND, [LABEL.service]: service.id },
      HostConfig: { NetworkMode: "none", AutoRemove: false },
    });
    await container.start();
    // Ready when the engine's own health check passes.
    const health = engine.healthcheck(creds).slice(1).join(" ");
    const started = Date.now();
    for (;;) {
      const r = await execText(container, docker, ["sh", "-c", `${health} >/dev/null 2>&1 && echo ok`]).catch(() => null);
      if (r?.trim() === "ok") break;
      if (Date.now() - started > READY_MS) throw new Error("The throwaway database did not start within 3 minutes.");
      await new Promise((r2) => setTimeout(r2, 2000));
    }
    const stored = await localBackupFile(backup);
    await checkIntegrity(backup, stored);
    const opened = await openBackupFile(backup, stored);
    const t: Commands = {
      docker,
      container,
      engine: cfg.engine,
      backup: "",
      restore: engine.restoreCommand(creds),
      restoreFolder: engine.restoreFolderCommand?.(creds),
      restorePlain: cfg.engine === "postgres" ? `PGPASSWORD='${password}' psql -X -v ON_ERROR_STOP=1 -q -o /dev/null -U '${creds.username}' -d '${creds.database}'` : undefined,
      password,
      database: creds.database,
      username: creds.username,
      creds,
    };
    log("restoring");
    try {
      await restoreWith(t, opened.file, () => {}, { keepNames: true });
    } finally {
      await opened.done();
    }
    // A restore that "worked" but leaves nothing to count did not work.
    const counted = await execText(container, docker, ["sh", "-c", COUNT[cfg.engine](password, creds.database, creds.username)]).catch(() => null);
    const detail = counted?.trim().split("\n").at(-1);
    if (!detail) throw new Error("The restore ran, but the throwaway database did not answer afterwards.");
    await db.update(schema.backup).set({ verifyStatus: "passed", verifiedAt: new Date(), verifyError: null, verifyDetail: detail }).where(eq(schema.backup.id, backupId));
    log(`passed: ${detail}`);
    void notify(await orgOfService(service.id), "backup.test.passed", {
      ok: true,
      title: `A backup of ${service.name} restores`,
      body: `${backup.filename}: ${detail}`,
      url: `/projects/${service.projectId}/services/${service.id}/backups`,
      serviceId: service.id,
      dedupKey: `backup-test:${service.id}`,
      data: { backupId },
    });
    return detail;
  } catch (error) {
    const message = (error as Error).message.slice(0, 1000);
    await db.update(schema.backup).set({ verifyStatus: "failed", verifiedAt: new Date(), verifyError: message }).where(eq(schema.backup.id, backupId));
    log(`failed: ${message}`);
    void notify(await orgOfService(service.id), "backup.test.failed", {
      ok: false,
      title: `A backup of ${service.name} could not be restored`,
      body: message.slice(0, 400),
      url: `/projects/${service.projectId}/services/${service.id}/backups`,
      error: message,
      serviceId: service.id,
      dedupKey: `backup-test:${service.id}`,
      data: { backupId },
    });
    throw error;
  } finally {
    if (container) await container.remove({ force: true, v: true }).catch(() => {});
  }
}

/** Newest successful backups of databases with backup proof on, not tested in the last day. */
export async function dueBackupTests() {
  const rows = await db
    .select({
      id: schema.backup.id,
      serviceId: schema.backup.serviceId,
      createdAt: schema.backup.createdAt,
      verifiedAt: schema.backup.verifiedAt,
      verifyStatus: schema.backup.verifyStatus,
      database: schema.service.database,
      target: schema.backup.target,
    })
    .from(schema.backup)
    .innerJoin(schema.service, eq(schema.backup.serviceId, schema.service.id))
    .where(and(eq(schema.backup.status, "success"), isNull(schema.backup.target), eq(schema.service.status, "running")))
    .orderBy(desc(schema.backup.createdAt));
  const newest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (r.database?.backupVerify && !newest.has(r.serviceId)) newest.set(r.serviceId, r);
  const dayAgo = Date.now() - 86_400_000;
  // Not running, and either never tested or tested more than a day ago (a new backup is never tested yet).
  return [...newest.values()].filter((r) => r.verifyStatus !== "running" && (!r.verifiedAt || r.verifiedAt.getTime() < dayAgo)).map((r) => r.id);
}
