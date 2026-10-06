import fs from "node:fs";
import { Readable } from "node:stream";
import { requireInstanceAdmin } from "@/server/auth";
import { s3For } from "@/server/backups";
import { s3Stream } from "@/server/backups/s3";
import { instanceBackupFile } from "@/server/instance/backups";
import { getSettings } from "@/server/settings";

/** Downloads an instance backup bundle (Root admins only). Falls back to the S3 copy. */
export async function GET(_req: Request, ctx: RouteContext<"/api/instance/backups/[backupId]/download">) {
  const { backupId } = await ctx.params;
  const admin = await requireInstanceAdmin().catch(() => null);
  if (!admin) return new Response("Not found", { status: 404 });
  const settings = await getSettings();
  const b = settings.instanceBackups.find((x) => x.id === backupId);
  if (!b?.filename || b.status !== "success") return new Response("Not found", { status: 404 });
  const headers = { "content-type": b.filename.endsWith(".enc") ? "application/octet-stream" : "application/gzip", "content-disposition": `attachment; filename="${b.filename}"` };
  const file = instanceBackupFile(b.filename);
  if (fs.existsSync(file)) {
    const { size } = fs.statSync(file);
    return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, { headers: { ...headers, "content-length": String(size) } });
  }
  // The destination it was uploaded to, not today's setting (older records did not keep it).
  const s3 = b.s3Key ? await s3For(b.s3DestinationId ?? settings.instanceBackupS3DestinationId).catch(() => null) : null;
  const remote = s3 && b.s3Key ? await s3Stream(s3, b.s3Key).catch(() => null) : null;
  if (!remote) return new Response("The backup file is no longer stored.", { status: 404 });
  return new Response(remote.body as ReadableStream, { headers: { ...headers, ...(remote.size ? { "content-length": String(remote.size) } : {}) } });
}
