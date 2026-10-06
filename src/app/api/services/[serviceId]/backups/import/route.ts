import { NextResponse } from "next/server";
import { requirePermission } from "@/server/auth";
import { serviceInOrg } from "@/server/services/access";
import { ImportError, receiveImport } from "@/server/backups/import-upload";
import { crossSiteRequest } from "@/lib/same-origin";
import { env } from "@/server/env";

export const dynamic = "force-dynamic";

/**
 * Streams an uploaded dump to disk (never held in memory), then queues the restore.
 * Body: the raw file. Query: ?filename=…&backupFirst=1&users=1&database=… (restore the file's one database into it), &restore=0 (only receive it) (MongoDB: also its users)
 */
export async function POST(request: Request, ctx: RouteContext<"/api/services/[serviceId]/backups/import">) {
  // Outside the proxy matcher, so its cross-site check is done here.
  if (crossSiteRequest(request, env.appUrl)) return NextResponse.json({ error: "Cross-site request refused." }, { status: 403 });
  const { serviceId } = await ctx.params;
  let org;
  try {
    org = await requirePermission("databases.backups");
  } catch {
    return NextResponse.json({ error: "Your role cannot manage backups." }, { status: 403 });
  }
  // Importing overwrites live data: admins only, like restoring.
  if (!org.isAdmin) return NextResponse.json({ error: "Only organization admins can import backups." }, { status: 403 });
  let service;
  try {
    ({ service } = await serviceInOrg(serviceId, org.org.id));
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (service.status !== "running")
    return NextResponse.json({ error: service.database ? "Start the database before importing." : "Start the stack before importing." }, { status: 409 });
  const url = new URL(request.url);
  try {
    return NextResponse.json(
      await receiveImport({
        service,
        // A database service, or one backup of a compose stack (?target=db:postgres, volume:data…).
        target: url.searchParams.get("target") || null,
        filename: url.searchParams.get("filename") ?? "",
        body: request.body,
        declared: Number(request.headers.get("content-length") ?? 0),
        backupFirst: url.searchParams.get("backupFirst") === "1",
        users: url.searchParams.get("users") === "1",
        intoDatabase: url.searchParams.get("database") || null,
        receiveOnly: url.searchParams.get("restore") === "0",
        // An encrypted file's passphrase comes in a header, never the URL, which logs keep.
        passphrase: request.headers.get("x-backup-passphrase"),
        userId: org.user.id,
      }),
    );
  } catch (e) {
    if (e instanceof ImportError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
