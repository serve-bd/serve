import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decrypt } from "@/server/crypto";
import { serverOf } from "@/server/servers/context";
import { engines } from "@/server/databases/engines";
import { databaseCreds } from "@/server/databases/options";
import type { EngineCreds } from "@/server/databases/engines";
import type { DatabaseConfig } from "@/server/services/types";
import { newId } from "@/server/id";
import { paths } from "@/server/paths";
import { notify, orgOfService } from "@/server/notify";
import { s3Delete, s3Download, s3Stream, s3Upload, type S3Config } from "./s3";

export async function s3For(id: string | null | undefined): Promise<(S3Config & { prefix: string; id: string }) | null> {
  if (!id) return null;
  const [row] = await db.select().from(schema.s3Destination).where(eq(schema.s3Destination.id, id));
  if (!row) return null;
  return {
    id: row.id,
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

export async function runBackup(backupId: string) {
  const backup = await db.query.backup.findFirst({
    where: eq(schema.backup.id, backupId),
    with: { service: true },
  });
  if (!backup?.service.database) return;
  const service = backup.service;
  const cfg = service.database!;
  const engine = engines[cfg.engine];
  const creds = databaseCreds(cfg, decrypt(cfg.password));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${service.slug}-${stamp}.${engine.backupExtension}`;
  const file = backupFile(service.id, filename);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });

  try {
    // The dump runs next to the database on its server and streams back here.
    const { docker } = await serverOf(service);
    const exec = await docker.getContainer(service.slug).exec({
      Cmd: ["sh", "-c", engine.backupCommand(creds)],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let errText = "";
    stderr.on("data", (c: Buffer) => (errText += c.toString()));
    docker.modem.demuxStream(stream, stdout, stderr);
    stream.on("end", () => {
      stdout.end();
      stderr.end();
    });
    await pipeline(stdout, fs.createWriteStream(file));
    const info = await exec.inspect();
    if (info.ExitCode !== 0) throw new Error(errText.trim() || `Backup command exited with ${info.ExitCode}`);
    const { size } = await fs.promises.stat(file);
    if (size === 0) throw new Error(errText.trim() || "Backup produced an empty file");

    await logLine(backup.id, `Dumped ${filename} (${size} bytes)`);

    // A failed upload keeps the local copy; the backup still counts.
    const s3 = await s3For(cfg.s3DestinationId);
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
      .set({ status: "success", filename, size, destination: s3Status === "uploaded" ? s3!.id : "local", s3Status, finishedAt: new Date() })
      .where(eq(schema.backup.id, backup.id));
    await applyRetention(service.id, cfg.backupRetention, cfg.backupRetentionS3 ?? cfg.backupRetention, cfg.s3DestinationId);
    if (backup.trigger === "schedule") {
      void notify(await orgOfService(service.id), "backup.success", {
        ok: true,
        title: `Backup of ${service.name} finished`,
        body: filename,
        url: `/projects/${service.projectId}/services/${service.id}/backups`,
      });
    }
  } catch (error) {
    await fs.promises.rm(file, { force: true });
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(schema.backup)
      .set({ status: "failed", error: message.slice(0, 2000), finishedAt: new Date() })
      .where(eq(schema.backup.id, backup.id));
    void notify(await orgOfService(service.id), "backup.failed", {
      ok: false,
      title: `Backup of ${service.name} failed`,
      body: message.slice(0, 400),
      url: `/projects/${service.projectId}/services/${service.id}/backups`,
    });
    throw error;
  }
}

/**
 * Keeps the newest `keepLocal` backups on this machine and `keepS3` in S3. A backup
 * whose copies are all gone is removed from the list. Imported files are kept.
 */
async function applyRetention(serviceId: string, keepLocal: number, keepS3: number, s3Id?: string | null) {
  const rows = await db
    .select()
    .from(schema.backup)
    .where(and(eq(schema.backup.serviceId, serviceId), eq(schema.backup.status, "success")))
    .orderBy(desc(schema.backup.createdAt));
  const own = rows.filter((b) => b.trigger !== "import");
  const [svc] = await db.select({ slug: schema.service.slug }).from(schema.service).where(eq(schema.service.id, serviceId));
  for (const [i, b] of own.entries()) {
    if (!b.filename) continue;
    const dropLocal = i >= Math.max(1, keepLocal);
    const inS3 = b.destination !== "local";
    const dropS3 = inS3 && i >= Math.max(1, keepS3);
    if (dropLocal) await fs.promises.rm(backupFile(serviceId, b.filename), { force: true });
    if (dropS3 && svc) {
      const s3 = await s3For(b.destination);
      if (s3) await s3Delete(s3, s3Key(s3.prefix, svc.slug, b.filename)).catch(() => {});
      await db.update(schema.backup).set({ s3Status: "deleted", destination: "local" }).where(eq(schema.backup.id, b.id));
    }
    if (dropLocal && (!inS3 || dropS3)) await db.delete(schema.backup).where(eq(schema.backup.id, b.id));
  }
  void s3Id;
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

export async function deleteBackupFiles(b: typeof schema.backup.$inferSelect, s3Id?: string | null) {
  if (!b.filename) return;
  await fs.promises.rm(backupFile(b.serviceId, b.filename), { force: true });
  const destination = b.destination !== "local" ? b.destination : s3Id;
  const s3 = await s3For(destination);
  if (s3) {
    const [svc] = await db.select({ slug: schema.service.slug }).from(schema.service).where(eq(schema.service.id, b.serviceId));
    if (svc) await s3Delete(s3, s3Key(s3.prefix, svc.slug, b.filename)).catch(() => {});
  }
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
async function restoreCommandFor(cfg: DatabaseConfig, creds: EngineCreds, file: string, gz: boolean) {
  const engine = engines[cfg.engine];
  if (cfg.engine === "postgres") {
    const head = await peek(file, gz, 5);
    if (head.toString("latin1") !== "PGDMP") {
      const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
      return { command: `PGPASSWORD=${q(creds.password)} psql -v ON_ERROR_STOP=1 -q -U ${q(creds.username)} -d ${q(creds.database)}`, format: "plain SQL" };
    }
    return { command: engine.restoreCommand(creds), format: "pg_dump custom format" };
  }
  return { command: engine.restoreCommand(creds), format: engine.backupExtension };
}

export async function restoreBackup(backupId: string) {
  const backup = await db.query.backup.findFirst({ where: eq(schema.backup.id, backupId), with: { service: true } });
  if (!backup?.filename || !backup.service.database) throw new Error("Backup not found");
  const service = backup.service;
  const cfg = service.database!;
  const creds = databaseCreds(cfg, decrypt(cfg.password));
  const file = backupFile(service.id, backup.filename);
  await db.update(schema.backup).set({ restoreStatus: "running" }).where(eq(schema.backup.id, backupId));
  await logLine(backupId, `Restoring into ${service.name}`);
  try {
    if (!fs.existsSync(file)) {
      const s3 = await s3For(backup.destination !== "local" ? backup.destination : null);
      if (!s3) throw new Error("The backup file is missing.");
      await logLine(backupId, "Downloading from S3");
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await s3Download(s3, s3Key(s3.prefix, service.slug, backup.filename), file);
    }
    // Mongo archives are gzip streams already; everything else ending in .gz is unpacked on the way in.
    const gz = /\.gz$/i.test(backup.filename) && cfg.engine !== "mongodb";
    const { command, format } = await restoreCommandFor(cfg, creds, file, gz);
    await logLine(backupId, `Format: ${format}${gz ? " (gzip)" : ""}`);
    const { docker } = await serverOf(service);
    const exec = await docker.getContainer(service.slug).exec({
      Cmd: ["sh", "-c", command],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: true });
    let output = "";
    const sink = new PassThrough();
    sink.on("data", (c: Buffer) => (output += c.toString()));
    docker.modem.demuxStream(stream, sink, sink);
    const done = new Promise<void>((resolve) => stream.on("end", resolve));
    const source = fs.createReadStream(file);
    await pipeline(gz ? source.pipe(zlib.createGunzip()) : source, stream, { end: false }).catch(() => {});
    (stream as unknown as { end: () => void }).end();
    await done;
    const info = await exec.inspect();
    const clean = output.replaceAll(creds.password, "***").trim();
    if (info.ExitCode && info.ExitCode !== 0) throw new Error(clean.slice(-1500) || `Restore exited with ${info.ExitCode}`);
    if (cfg.engine === "redis" || cfg.engine === "valkey") {
      await logLine(backupId, "Restarting to load the dump");
      await docker.getContainer(service.slug).restart();
    }
    if (clean) await logLine(backupId, clean.slice(-2000));
    await db.update(schema.backup).set({ restoreStatus: "success", restoredAt: new Date() }).where(eq(schema.backup.id, backupId));
    await logLine(backupId, "Restore finished");
    return clean;
  } catch (error) {
    const message = (error as Error).message;
    await db.update(schema.backup).set({ restoreStatus: "failed", restoredAt: new Date() }).where(eq(schema.backup.id, backupId));
    await logLine(backupId, `Restore failed: ${message.slice(0, 2000)}`);
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
  postgres: [".dump", ".backup", ".sql", ".sql.gz", ".dump.gz"],
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
  const ext = IMPORT_EXTENSIONS[engine].find((e) => base.endsWith(e));
  if (!ext) throw new Error(`Upload a ${IMPORT_EXTENSIONS[engine].join(", ")} file.`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${slug}-import-${stamp}-${base}`;
}

export async function importBackup(backupId: string, opts: { backupFirst?: boolean; url?: string; s3?: { destinationId: string; key: string } }) {
  const backup = await db.query.backup.findFirst({ where: eq(schema.backup.id, backupId), with: { service: true } });
  if (!backup?.filename || !backup.service.database) throw new Error("Import not found");
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
      await db.update(schema.backup).set({ status: "success", size, finishedAt: new Date() }).where(eq(schema.backup.id, backupId));
      await logLine(backupId, `Received ${backup.filename} (${size} bytes)`);
    }
  } catch (error) {
    if (backup.status !== "success") {
      await fs.promises.rm(file, { force: true });
      await db
        .update(schema.backup)
        .set({ status: "failed", error: (error as Error).message.slice(0, 2000), finishedAt: new Date() })
        .where(eq(schema.backup.id, backupId));
    }
    throw error;
  }

  if (opts.backupFirst) {
    const id = newId();
    await db.insert(schema.backup).values({ id, serviceId: service.id, trigger: "pre-import" });
    await logLine(backupId, "Backing up the current data first");
    try {
      await runBackup(id);
    } catch (e) {
      await logLine(backupId, `The safety backup failed, so nothing was restored: ${(e as Error).message}`);
      throw new Error("The safety backup failed, so nothing was restored.");
    }
  }
  await restoreBackup(backupId);
}
