import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { notFound, requireToken, tokenService } from "@/server/api-auth";

/** Deployment status with the end of its build log. Scope: read. */
export async function GET(request: Request, ctx: RouteContext<"/api/v1/deployments/[deploymentId]">) {
  const { auth, error } = await requireToken(request, "read");
  if (error) return error;
  const { deploymentId } = await ctx.params;
  const [d] = await db.select().from(schema.deployment).where(eq(schema.deployment.id, deploymentId));
  if (!d || !(await tokenService(auth, d.serviceId))) return notFound();
  const { logs, ...rest } = d;
  return Response.json({ deployment: { ...rest, logTail: logs.slice(-4000) } });
}
