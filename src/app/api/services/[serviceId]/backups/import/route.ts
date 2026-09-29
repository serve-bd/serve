import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NextResponse } from "next/server";
import { requireOrgAdmin } from "@/server/auth";
import { db, schema } from "@/server/db";
import { newId } from "@/server/id";
import { enqueue } from "@/server/queue";
import { logActivity } from "@/server/activity";
import { serviceInOrg } from "@/server/services/access";
import { backupFile, importFilename } from "@/server/backups";

export const dynamic = "force-dynamic";

/** Largest dump accepted through the dashboard. */
const MAX_BYTES = 20 * 1024 ** 3;

/**
 * Streams an uploaded dump to disk (never held in memory), then queues the restore.
 * Body: the raw file. Query: ?filename=…&backupFirst=1
 */
export async function POST(request: Request, ctx: RouteContext<"/api/services/[serviceId]/backups/import">) {
  const { serviceId } = await ctx.params;
  let org;
  try {
    org = await requireOrgAdmin();
  } catch {
    return NextResponse.json({ error: "Only organization admins can restore backups." }, { status: 403 });
  }
  let service;
  try {
    ({ service } = await serviceInOrg(serviceId, org.org.id));
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!service.database) return NextResponse.json({ error: "Not a database." }, { status: 400 });
  if (service.status !== "running") return NextResponse.json({ error: "Start the database before importing." }, { status: 409 });
  const url = new URL(request.url);
  let filename: string;
  try {
    filename = importFilename(service.database.engine, service.slug, url.searchParams.get("filename") ?? "");
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  if (!request.body) return NextResponse.json({ error: "Choose a file." }, { status: 400 });
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) return NextResponse.json({ error: "The file is larger than 20 GB." }, { status: 413 });

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
    await pipeline(Readable.fromWeb(request.body as never), limit, fs.createWriteStream(file));
  } catch (e) {
    await fs.promises.rm(file, { force: true });
    return NextResponse.json({ error: `Upload failed: ${(e as Error).message}` }, { status: 400 });
  }
  if (!size) {
    await fs.promises.rm(file, { force: true });
    return NextResponse.json({ error: "The file is empty." }, { status: 400 });
  }

  const id = newId();
  await db.insert(schema.backup).values({ id, serviceId, trigger: "import", status: "running", filename, size, log: `Uploaded ${filename} (${size} bytes)\n` });
  await enqueue("backup.import", { backupId: id, backupFirst: url.searchParams.get("backupFirst") === "1" }, { concurrencyKey: `backup:${serviceId}` });
  await logActivity({
    userId: org.user.id,
    projectId: service.projectId,
    action: "backup.import",
    targetType: "service",
    targetId: service.id,
    message: `Importing a backup into ${service.name}`,
  });
  return NextResponse.json({ id });
}
