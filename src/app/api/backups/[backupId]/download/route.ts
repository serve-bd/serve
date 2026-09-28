import fs from "node:fs";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { serviceInOrg } from "@/server/services/access";
import { backupFile } from "@/server/backups";

export async function GET(_req: Request, ctx: RouteContext<"/api/backups/[backupId]/download">) {
  const { backupId } = await ctx.params;
  const org = await requireOrg();
  const [b] = await db.select().from(schema.backup).where(eq(schema.backup.id, backupId));
  if (!b?.filename) return new Response("Not found", { status: 404 });
  try {
    await serviceInOrg(b.serviceId, org.org.id);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const file = backupFile(b.serviceId, b.filename);
  if (!fs.existsSync(file)) return new Response("The backup file is only stored remotely.", { status: 404 });
  const stat = fs.statSync(file);
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(stat.size),
      "content-disposition": `attachment; filename="${b.filename}"`,
    },
  });
}
