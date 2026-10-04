import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { formatBytes } from "@/lib/utils";
import { paths } from "@/server/paths";
import { ArchiveError, checkArchive } from "./upload-archive";

/*
 * Project folders the CLI uploads (serve deploy), kept as .tar.gz under uploads/<serviceId>/.
 * The deployment row points at its archive; a redeploy builds the same archive again. The
 * archives of the last few upload deployments of a service are kept, older ones are deleted
 * (a rollback reuses the image, not the files).
 */

/** Upload deployments per service whose files are kept. */
export const KEEP_UPLOADS = 5;

/** Room left free on the disk while an upload is written or unpacked. */
const DISK_RESERVE = 256 * 1024 ** 2;

export class UploadError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The archive file of a deployment ("<serviceId>/<id>.tar.gz"), never outside the uploads folder. */
export function uploadPath(archive: string) {
  const root = path.resolve(paths.uploads);
  const file = path.resolve(root, archive);
  if (!file.startsWith(root + path.sep)) throw new Error("Invalid upload path.");
  return file;
}

/** Free bytes on the disk that holds `dir` (null when it cannot be told). */
export async function freeBytes(dir: string): Promise<number | null> {
  const stat = await fs.promises.statfs(dir).catch(() => null);
  return stat ? stat.bavail * stat.bsize : null;
}

/** Whether `need` more bytes fit on the disk of `dir` with the reserve left over. */
export async function hasRoom(dir: string, need: number) {
  const free = await freeBytes(dir);
  return free === null || free - need >= DISK_RESERVE;
}

/** The refusal for an upload of `need` bytes when the disk lacks room, else null. */
export function noRoomMessage(free: number | null, need: number) {
  if (free === null || free - need >= DISK_RESERVE) return null;
  const size = (n: number) => formatBytes(n).replace(/\.0 /, " ");
  return `Not enough disk space on the Serve server: ${size(Math.max(0, free))} free${need ? `, the upload is ${size(need)}` : ""} and ${size(DISK_RESERVE)} must stay free.`;
}

/**
 * Streams an uploaded .tar.gz to disk (never held in memory) and checks it: every entry stays
 * inside the folder. Returns the stored archive, or throws an UploadError with the status to answer.
 */
export async function receiveUpload(serviceId: string, deploymentId: string, body: ReadableStream<Uint8Array> | null, declaredSize: number) {
  if (!body) throw new UploadError(400, "The request has no body. Send the project folder as a .tar.gz.");
  const dir = path.join(paths.uploads, serviceId);
  await fs.promises.mkdir(dir, { recursive: true });
  const full = noRoomMessage(await freeBytes(dir), declaredSize);
  if (full) throw new UploadError(507, full);
  // Named after its deployment: two uploads at the same moment never share a file.
  const archive = `${serviceId}/${deploymentId}.tar.gz`;
  const file = uploadPath(archive);
  const part = `${file}.part`;
  let size = 0;
  let checked = 0;
  const watch = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size - checked < 64 * 1024 ** 2) return cb(null, chunk);
      checked = size;
      freeBytes(dir).then(
        (free) => {
          const full = noRoomMessage(free, 0);
          cb(full ? new UploadError(507, full) : null, chunk);
        },
        () => cb(null, chunk),
      );
    },
  });
  try {
    await pipeline(Readable.fromWeb(body as never), watch, fs.createWriteStream(part, { flags: "wx" }));
    if (!size) throw new UploadError(400, "The upload is empty.");
    const summary = await checkArchive(part);
    await fs.promises.rename(part, file);
    return { archive, size, files: summary.files, bytes: summary.bytes };
  } catch (e) {
    await fs.promises.rm(part, { force: true }).catch(() => {});
    if (e instanceof UploadError) throw e;
    if (e instanceof ArchiveError) throw new UploadError(400, e.message);
    if ((e as NodeJS.ErrnoException).code === "ENOSPC") throw new UploadError(507, "Not enough disk space on the Serve server: the disk filled up during the upload.");
    // The client went away (Ctrl+C, a dropped connection): nothing is kept and nothing is queued.
    throw new UploadError(400, `The upload did not finish: ${(e as Error).message}`);
  }
}

/** Removes a stored archive (a deployment that was never queued). */
export async function discardUpload(archive: string) {
  await fs.promises.rm(uploadPath(archive), { force: true }).catch(() => {});
}

/**
 * Archives no recent upload deployment uses: the files of the newest KEEP_UPLOADS upload deployments
 * stay (a queued redeploy of an older one counts as recent), everything else in the folder goes.
 * Unfinished uploads (.part) are left alone unless they are a day old.
 */
export async function pruneUploads(serviceId: string, keep = KEEP_UPLOADS) {
  const { db, schema } = await import("@/server/db");
  const recent = await db
    .select({ upload: schema.deployment.upload })
    .from(schema.deployment)
    .where(and(eq(schema.deployment.serviceId, serviceId), isNotNull(schema.deployment.upload)))
    .orderBy(desc(schema.deployment.createdAt))
    .limit(keep);
  const kept = new Set(recent.map((r) => path.basename(r.upload!.archive)));
  const dir = path.join(paths.uploads, serviceId);
  const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
  const removed: string[] = [];
  for (const name of uploadsToRemove(names, kept)) {
    const file = path.join(dir, name);
    if (name.endsWith(".part")) {
      const stat = await fs.promises.stat(file).catch(() => null);
      if (!stat || Date.now() - stat.mtimeMs < 86_400_000) continue;
    }
    await fs.promises.rm(file, { force: true }).catch(() => {});
    removed.push(name);
  }
  return removed;
}

/** File names in a service's uploads folder that are not among the kept archives. */
export function uploadsToRemove(names: string[], kept: Set<string>) {
  return names.filter((n) => !kept.has(n));
}

/** Whether a deployment's archive is still on disk. */
export async function uploadExists(archive: string) {
  return fs.promises
    .access(uploadPath(archive))
    .then(() => true)
    .catch(() => false);
}
