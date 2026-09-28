import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { apiAuth, unauthorized } from "@/server/api-auth";
import { serviceInOrg } from "@/server/services/access";

export async function GET(request: Request, ctx: RouteContext<"/api/v1/deployments/[deploymentId]">) {
  const auth = await apiAuth(request);
  if (!auth) return unauthorized();
  const { deploymentId } = await ctx.params;
  const [d] = await db.select().from(schema.deployment).where(eq(schema.deployment.id, deploymentId));
  if (!d) return Response.json({ error: "Not found" }, { status: 404 });
  try {
    await serviceInOrg(d.serviceId, auth.organizationId);
  } catch {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const { logs, ...rest } = d;
  return Response.json({ deployment: { ...rest, logTail: logs.slice(-4000) } });
}
