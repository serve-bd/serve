import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { serviceInOrg } from "@/server/services/access";

export async function GET(_req: Request, ctx: RouteContext<"/api/services/[serviceId]/tasks">) {
  const { serviceId } = await ctx.params;
  const org = await requireOrg();
  // Task runs carry command output, like logs.
  if (!org.can("logs.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    await serviceInOrg(serviceId, org.org.id);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const [tasks, runs] = await Promise.all([
    db.select().from(schema.scheduledTask).where(eq(schema.scheduledTask.serviceId, serviceId)).orderBy(schema.scheduledTask.createdAt),
    db.select().from(schema.taskRun).where(eq(schema.taskRun.serviceId, serviceId)).orderBy(desc(schema.taskRun.startedAt)).limit(60),
  ]);
  return NextResponse.json({ tasks, runs });
}
