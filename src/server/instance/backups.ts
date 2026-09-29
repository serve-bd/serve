import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { docker, demuxDockerBuffer, imageExists, pullImage } from "@/server/docker/client";
import { env } from "@/server/env";
import { newId } from "@/server/id";
import { s3Delete, s3Upload } from "@/server/backups/s3";
import { s3For } from "@/server/backups";
import { getSettings, type InstanceBackup, type Settings } from "@/server/settings";
import { SCHEMA_VERSION } from "@/server/version";
import { buildManifest, bundleName, expiredBackups, INSTANCE_BACKUP_EXCLUDES, INSTANCE_BACKUP_PATHS, scheduleDue } from "./manifest";
import { currentCommit, currentVersion } from "./version";
import { notify } from "@/server/notify";

const MAX_KEPT_RECORDS = 50;

export const instanceBackupDir = () => path.join(env.dataDir, "backups", "instance");
export const instanceBackupFile = (filename: string) => path.join(instanceBackupDir(), path.basename(filename));

/** Read-modify-write the backup list, one writer at a time (web and worker both change it). */
async function mutateBackups(fn: (list: InstanceBackup[]) => InstanceBackup[]) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('serve:instance-backups'))`);
    const [row] = await tx.select().from(schema.setting).where(eq(schema.setting.key, "instanceBackups"));
    const next = fn(((row?.value as InstanceBackup[] | undefined) ?? []).slice()).slice(0, MAX_KEPT_RECORDS);
    await tx
      .insert(schema.setting)
      .values({ key: "instanceBackups", value: next as never })
      .onConflictDoUpdate({ target: schema.setting.key, set: { value: next as never, updatedAt: new Date() } });
    return next;
  });
}

const patchBackup = (id: string, patch: Partial<InstanceBackup>) => mutateBackups((list) => list.map((b) => (b.id === id ? { ...b, ...patch } : b)));

/** Records a pending backup; the worker's instance.backup job fills it in. */
export async function queueInstanceBackupRecord(trigger: InstanceBackup["trigger"]) {
  const id = newId();
  const record: InstanceBackup = {
    id,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    trigger,
    filename: null,
    size: null,
    s3Key: null,
    s3Status: null,
    error: null,
    version: currentVersion(),
  };
  await mutateBackups((list) => [record, ...list]);
  return id;
}

/** Host (as Docker sees it) and credentials of Serve's own database. */
function databaseTarget() {
  const url = new URL(env.databaseUrl);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port || "5432",
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, "") || "postgres",
    // A database on the host's loopback (development) is reached with host networking.
    networkMode: local ? "host" : env.network,
  };
}

async function postgresMajor(): Promise<{ major: number; version: string | null }> {
  const rows = await db.execute<{ v: string; n: string }>(sql`select current_setting('server_version') as v, current_setting('server_version_num') as n`);
  const row = [...rows][0];
  return { major: Math.floor(Number(row?.n ?? 170000) / 10000), version: row?.v ?? null };
}

/**
 * Dumps the database and packs it with the instance files into one .tar.gz. Both run in a
 * short-lived Postgres client container: pg_dump must match the server's major version,
 * and root inside the container can read the certificate keys the proxy writes.
 */
async function writeBundle(id: string, log: (line: string) => void): Promise<{ filename: string; size: number }> {
  const dir = instanceBackupDir();
  const tmp = path.join(dir, `.tmp-${id}`);
  await fs.promises.mkdir(tmp, { recursive: true });
  const createdAt = new Date();
  const version = currentVersion();
  const filename = bundleName(createdAt, version);
  const files = INSTANCE_BACKUP_PATHS.filter((p) => fs.existsSync(path.join(env.dataDir, p)));
  const pg = await postgresMajor();
  const manifest = buildManifest({ version, commit: currentCommit(), schemaVersion: SCHEMA_VERSION, createdAt, files, pgServerVersion: pg.version });
  await fs.promises.writeFile(path.join(tmp, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const image = `postgres:${pg.major}-alpine`;
  if (!(await imageExists(image))) {
    log(`Pulling ${image}`);
    await pullImage(image);
  }
  const target = databaseTarget();
  const owner = typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid?.() ?? 0}` : "0:0";
  // Staged inside the container, then packed with one tar: BusyBox tar keeps only the last -C.
  const script = [
    "set -e",
    "mkdir -p /stage",
    `pg_dump --format=custom --no-owner --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" --dbname="$PGDATABASE" --file=/stage/database.dump`,
    "cp /out/manifest.json /stage/manifest.json",
    ...files.map((f) => `cp -a '/src/${f}' '/stage/${f}'`),
    ...INSTANCE_BACKUP_EXCLUDES.map((e) => `rm -rf /stage/${e}`),
    // Plain member names (no "./"), so `tar -x manifest.json` finds them when restoring.
    "cd /stage && tar -czf /out/bundle.tar.gz $(ls -A)",
    `chown -R ${owner} /out`,
  ].join("\n");
  const container = await docker.createContainer({
    Image: image,
    Entrypoint: ["sh", "-c"],
    Cmd: [script],
    Env: [`PGHOST=${target.host}`, `PGPORT=${target.port}`, `PGUSER=${target.user}`, `PGPASSWORD=${target.password}`, `PGDATABASE=${target.database}`],
    Labels: { "serve.managed": "true", "serve.kind": "instance-backup" },
    HostConfig: { NetworkMode: target.networkMode, Binds: [`${env.dataDir}:/src:ro`, `${tmp}:/out`] },
  });
  try {
    log("Dumping the database and packing instance files");
    await container.start();
    const { StatusCode } = await container.wait();
    if (StatusCode !== 0) {
      const out = demuxDockerBuffer((await container.logs({ stdout: true, stderr: true })) as unknown as Buffer).trim();
      throw new Error(out.split("\n").slice(-6).join("\n") || `The backup container exited with code ${StatusCode}.`);
    }
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
  const file = path.join(dir, filename);
  await fs.promises.rename(path.join(tmp, "bundle.tar.gz"), file);
  await fs.promises.rm(tmp, { recursive: true, force: true });
  return { filename, size: (await fs.promises.stat(file)).size };
}

/** Runs one instance backup (the record must exist) and applies retention afterwards. */
export async function runInstanceBackup(id: string, log: (line: string) => void = () => {}) {
  const settings = await getSettings();
  try {
    const { filename, size } = await writeBundle(id, log);
    await patchBackup(id, { filename, size });
    let s3Key: string | null = null;
    let s3Status: InstanceBackup["s3Status"] = null;
    const s3 = settings.instanceBackupS3DestinationId ? await s3For(settings.instanceBackupS3DestinationId) : null;
    if (s3) {
      s3Key = [s3.prefix, "serve-instance", filename].filter(Boolean).join("/");
      try {
        log(`Uploading to s3://${s3.bucket}/${s3Key}`);
        await s3Upload(s3, s3Key, instanceBackupFile(filename));
        s3Status = "uploaded";
      } catch (e) {
        log(`Upload failed: ${(e as Error).message}`);
        s3Status = "failed";
      }
    }
    await patchBackup(id, { status: "success", finishedAt: new Date().toISOString(), s3Key, s3Status, error: null });
    const trigger = settings.instanceBackups.find((b) => b.id === id)?.trigger;
    if (trigger !== "manual") {
      await notify(settings.rootOrganizationId, "instance.backup.success", {
        ok: true,
        title: "Serve backup finished",
        body: `${filename}${s3Status === "failed" ? " (the S3 upload failed; the local copy is kept)" : ""}`,
        url: "/settings/backups",
        dedupKey: "instance-backup",
        data: { backupId: id, filename, size, s3: s3Status },
      });
    }
  } catch (e) {
    await patchBackup(id, { status: "failed", finishedAt: new Date().toISOString(), error: (e as Error).message.slice(0, 2000) });
    await notify(settings.rootOrganizationId, "instance.backup.failed", {
      ok: false,
      title: "Serve backup failed",
      body: (e as Error).message.slice(0, 400),
      url: "/settings/backups",
      dedupKey: "instance-backup",
      data: { backupId: id },
    });
    await fs.promises.rm(path.join(instanceBackupDir(), `.tmp-${id}`), { recursive: true, force: true }).catch(() => {});
    throw e;
  } finally {
    await applyRetention(settings).catch(() => {});
  }
}

/** Deletes one backup's local file, its S3 copy and its record. */
export async function deleteInstanceBackup(id: string) {
  const settings = await getSettings();
  const backup = settings.instanceBackups.find((b) => b.id === id);
  if (!backup) return;
  await removeFiles(backup, settings);
  await mutateBackups((list) => list.filter((b) => b.id !== id));
}

async function removeFiles(backup: InstanceBackup, settings: Settings) {
  if (backup.filename) await fs.promises.rm(instanceBackupFile(backup.filename), { force: true }).catch(() => {});
  if (backup.s3Key && backup.s3Status === "uploaded") {
    const s3 = await s3For(settings.instanceBackupS3DestinationId).catch(() => null);
    if (s3) await s3Delete(s3, backup.s3Key).catch(() => {});
  }
}

async function applyRetention(settings: Settings) {
  const fresh = await getSettings();
  const expired = expiredBackups(fresh.instanceBackups, settings.instanceBackupRetention);
  for (const b of expired) await removeFiles(b, fresh);
  if (expired.length) {
    const gone = new Set(expired.map((b) => b.id));
    await mutateBackups((list) => list.filter((b) => !gone.has(b.id)));
  }
}

let lastScheduled: string | null = null;

/** Worker tick: queue a scheduled instance backup when its cron fires. */
export async function scheduleInstanceBackups(enqueueBackup: (id: string) => Promise<unknown>) {
  const s = await getSettings();
  if (!s.instanceBackupSchedule) return;
  const due = scheduleDue(s.instanceBackupSchedule, new Date(), s.timezone, lastScheduled);
  if (!due) return;
  lastScheduled = due;
  if (s.instanceBackups.some((b) => b.status === "running")) return;
  await enqueueBackup(await queueInstanceBackupRecord("schedule"));
}

/** Records left "running" by a worker that stopped mid-backup. */
export async function failInterruptedInstanceBackups() {
  await mutateBackups((list) =>
    list.map((b) => (b.status === "running" ? { ...b, status: "failed", finishedAt: new Date().toISOString(), error: "The worker restarted during this backup." } : b)),
  );
}
