import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decrypt } from "@/server/crypto";
import { docker } from "@/server/docker/client";
import { engines } from "@/server/databases/engines";
import { paths } from "@/server/paths";
import { notify, orgOfService } from "@/server/notify";
import { s3Delete, s3Download, s3Upload, type S3Config } from "./s3";

async function s3For(id: string | null | undefined): Promise<(S3Config & { prefix: string; id: string }) | null> {
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

const s3Key = (prefix: string, serviceSlug: string, filename: string) =>
  [prefix, serviceSlug, filename].filter(Boolean).join("/");

export function backupFile(serviceId: string, filename: string) {
  return path.join(paths.backups, serviceId, filename);
}

export async function runBackup(backupId: string) {
  const backup = await db.query.backup.findFirst({
    where: eq(schema.backup.id, backupId),
    with: { service: true },
  });
  if (!backup || !backup.service.database) return;
  const service = backup.service;
  const cfg = service.database!;
  const engine = engines[cfg.engine];
  const creds = { username: cfg.username, password: decrypt(cfg.password), database: cfg.database };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${service.slug}-${stamp}.${engine.backupExtension}`;
  const file = backupFile(service.id, filename);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });

  try {
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

    const s3 = await s3For(cfg.s3DestinationId);
    if (s3) await s3Upload(s3, s3Key(s3.prefix, service.slug, filename), file);

    await db
      .update(schema.backup)
      .set({ status: "success", filename, size, destination: s3 ? s3.id : "local", finishedAt: new Date() })
      .where(eq(schema.backup.id, backup.id));
    await applyRetention(service.id, cfg.backupRetention, cfg.s3DestinationId);
    if (backup.trigger === "schedule") {
      void notify(await orgOfService(service.id), "backup.success", { ok: true, title: `Backup of ${service.name} finished`, body: filename, url: `/projects/${service.projectId}/services/${service.id}/backups` });
    }
  } catch (error) {
    await fs.promises.rm(file, { force: true });
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(schema.backup)
      .set({ status: "failed", error: message.slice(0, 2000), finishedAt: new Date() })
      .where(eq(schema.backup.id, backup.id));
    void notify(await orgOfService(service.id), "backup.failed", { ok: false, title: `Backup of ${service.name} failed`, body: message.slice(0, 400), url: `/projects/${service.projectId}/services/${service.id}/backups` });
    throw error;
  }
}

async function applyRetention(serviceId: string, keep: number, s3Id?: string | null) {
  const rows = await db
    .select()
    .from(schema.backup)
    .where(and(eq(schema.backup.serviceId, serviceId), eq(schema.backup.status, "success")))
    .orderBy(desc(schema.backup.createdAt));
  const stale = rows.slice(Math.max(1, keep));
  for (const b of stale) await deleteBackupFiles(b, s3Id);
  for (const b of stale) await db.delete(schema.backup).where(eq(schema.backup.id, b.id));
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

export async function restoreBackup(backupId: string) {
  const backup = await db.query.backup.findFirst({ where: eq(schema.backup.id, backupId), with: { service: true } });
  if (!backup?.filename || !backup.service.database) throw new Error("Backup not found");
  const service = backup.service;
  const cfg = service.database!;
  const engine = engines[cfg.engine];
  const creds = { username: cfg.username, password: decrypt(cfg.password), database: cfg.database };
  const file = backupFile(service.id, backup.filename);
  if (!fs.existsSync(file)) {
    const s3 = await s3For(backup.destination !== "local" ? backup.destination : null);
    if (!s3) throw new Error("The backup file is missing.");
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await s3Download(s3, s3Key(s3.prefix, service.slug, backup.filename), file);
  }
  const exec = await docker.getContainer(service.slug).exec({
    Cmd: ["sh", "-c", engine.restoreCommand(creds)],
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
  await pipeline(fs.createReadStream(file), stream, { end: false }).catch(() => {});
  (stream as unknown as { end: () => void }).end();
  await done;
  const info = await exec.inspect();
  if (info.ExitCode && info.ExitCode !== 0) throw new Error(output.trim().slice(-1500) || `Restore exited with ${info.ExitCode}`);
  if (cfg.engine === "redis" || cfg.engine === "valkey") {
    await docker.getContainer(service.slug).restart();
  }
  return output.trim();
}
