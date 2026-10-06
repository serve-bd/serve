import { cannotMessage } from "@/lib/permissions";
import fs from "node:fs";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { serviceInOrg } from "@/server/services/access";
import { backupFile, openS3Backup } from "@/server/backups";

export async function GET(_req: Request, ctx: RouteContext<"/api/backups/[backupId]/download">) {
  const { backupId } = await ctx.params;
  const org = await requireOrg();
  if (!org.can("databases.backups")) return new Response(cannotMessage("databases.backups"), { status: 403 });
  const [b] = await db.select().from(schema.backup).where(eq(schema.backup.id, backupId));
  // A backup still being written is not offered. An uploaded import's file is complete (its size is known); one fetched from a URL or S3 is not yet.
  if (!b?.filename || (b.status === "running" && !(b.trigger === "import" && b.size != null))) return new Response("Not found", { status: 404 });
  try {
    await serviceInOrg(b.serviceId, org.org.id);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const file = backupFile(b.serviceId, b.filename);
  if (!fs.existsSync(file)) {
    // Only in S3 (local copy removed by retention): stream it through.
    const remote = await openS3Backup(b).catch(() => null);
    if (!remote) return new Response("The backup file is no longer stored.", { status: 404 });
    return new Response(remote.body as ReadableStream, {
      headers: {
        "content-type": "application/octet-stream",
        ...(remote.size ? { "content-length": String(remote.size) } : {}),
        "content-disposition": `attachment; filename="${b.filename}"`,
        // The SHA-256 recorded when the backup was made: compare with sha256sum after downloading.
        ...(b.checksum ? { "x-checksum-sha256": b.checksum } : {}),
      },
    });
  }
  const stat = fs.statSync(file);
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(stat.size),
      "content-disposition": `attachment; filename="${b.filename}"`,
      ...(b.checksum ? { "x-checksum-sha256": b.checksum } : {}),
    },
  });
}
