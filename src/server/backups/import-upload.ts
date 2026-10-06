import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { db, schema } from "@/server/db";
import { encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { enqueue } from "@/server/queue";
import { logActivity } from "@/server/activity";
import { backupFile, importFilenameFor, importTarget, takenFilenames } from "./index";

/** Largest file an upload import takes. */
const MAX_BYTES = 20 * 1024 ** 3;

export class ImportError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * An uploaded backup into a database service, or one backup of a compose stack (`target`):
 * streamed to disk (never held in memory), then restored by the worker. Used by the dashboard
 * and the API alike. The passphrase of an encrypted file is stored encrypted in the job.
 */
export async function receiveImport(opts: {
  service: typeof schema.service.$inferSelect;
  target: string | null;
  filename: string;
  body: ReadableStream | null;
  declared: number;
  backupFirst: boolean;
  /** Only receive the file: it is restored later, from the restore window. */
  receiveOnly?: boolean;
  /** Restore the file's one database into this database of the server. */
  intoDatabase?: string | null;
  users: boolean;
  passphrase?: string | null;
  userId: string;
}) {
  const { service } = opts;
  if (service.status !== "running") throw new ImportError(409, service.database ? "Start the database before importing." : "Start the stack before importing.");
  let filename: string;
  try {
    const into = await importTarget(service, opts.target);
    filename = importFilenameFor(into.extensions, into.stem, opts.filename, await takenFilenames(service.id));
  } catch (e) {
    throw new ImportError(400, (e as Error).message);
  }
  if (opts.intoDatabase && !/^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$/.test(opts.intoDatabase)) throw new ImportError(400, "Choose a database name of letters, digits, _, $ and -.");
  if (!opts.body) throw new ImportError(400, "Choose a file.");
  if (opts.declared > MAX_BYTES) throw new ImportError(413, "The file is larger than 20 GB.");
  const file = backupFile(service.id, filename);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      cb(size > MAX_BYTES ? new Error("The file is larger than 20 GB.") : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(opts.body as never), limit, fs.createWriteStream(file));
  } catch (e) {
    await fs.promises.rm(file, { force: true });
    throw new ImportError(400, `Upload failed: ${(e as Error).message}`);
  }
  if (!size) {
    await fs.promises.rm(file, { force: true });
    throw new ImportError(400, "The file is empty.");
  }
  const id = newId();
  await db
    .insert(schema.backup)
    .values({ id, serviceId: service.id, target: opts.target, trigger: "import", status: "running", filename, size, log: `Uploaded ${filename} (${size} bytes)\n` });
  await enqueue(
    "backup.import",
    {
      backupId: id,
      ...(opts.receiveOnly ? { receiveOnly: true } : {}),
      backupFirst: opts.backupFirst,
      users: opts.users,
      ...(opts.intoDatabase ? { intoDatabase: opts.intoDatabase } : {}),
      ...(opts.passphrase ? { passphrase: encrypt(opts.passphrase) } : {}),
    },
    { concurrencyKey: `backup:${service.id}` },
  );
  await logActivity({
    userId: opts.userId,
    projectId: service.projectId,
    action: "backup.import",
    targetType: "service",
    targetId: service.id,
    message: `Importing a backup into ${service.name}`,
  });
  return { id };
}
