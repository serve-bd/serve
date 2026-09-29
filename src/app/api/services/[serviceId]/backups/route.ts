import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { serviceInOrg } from "@/server/services/access";

export async function GET(_req: Request, ctx: RouteContext<"/api/services/[serviceId]/backups">) {
  const { serviceId } = await ctx.params;
  const org = await requireOrg();
  if (!org.can("databases.backups")) return NextResponse.json({ error: "Your role cannot manage backups." }, { status: 403 });
  try {
    await serviceInOrg(serviceId, org.org.id);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const backups = await db.select().from(schema.backup).where(eq(schema.backup.serviceId, serviceId)).orderBy(desc(schema.backup.createdAt)).limit(100);
  const { hasLocalCopy } = await import("@/server/backups");
  return NextResponse.json({ backups: backups.map((b) => ({ ...b, local: hasLocalCopy(b) })) });
}
