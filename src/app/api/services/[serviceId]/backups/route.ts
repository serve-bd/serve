import { NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { serviceInOrg } from "@/server/services/access";

export async function GET(req: Request, ctx: RouteContext<"/api/services/[serviceId]/backups">) {
  const { serviceId } = await ctx.params;
  const org = await requireOrg();
  if (!org.can("databases.backups")) return NextResponse.json({ error: "Your role cannot manage backups." }, { status: 403 });
  try {
    await serviceInOrg(serviceId, org.org.id);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // A compose stack lists the backups of one target (?target=db:postgres); a database service has none.
  const target = new URL(req.url).searchParams.get("target");
  const backups = await db
    .select()
    .from(schema.backup)
    .where(and(eq(schema.backup.serviceId, serviceId), target ? eq(schema.backup.target, target) : isNull(schema.backup.target)))
    .orderBy(desc(schema.backup.createdAt))
    .limit(100);
  const { hasLocalCopy } = await import("@/server/backups");
  return NextResponse.json({ backups: backups.map(({ keyHint, ...b }) => ({ ...b, encrypted: !!keyHint, local: hasLocalCopy(b) })) });
}
