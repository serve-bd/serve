import { apiAuth, unauthorized } from "@/server/api-auth";
import { serviceInOrg } from "@/server/services/access";
import { queueDeployment } from "@/server/services/create";

export async function POST(request: Request, ctx: RouteContext<"/api/v1/services/[serviceId]/deploy">) {
  const auth = await apiAuth(request);
  if (!auth) return unauthorized();
  const { serviceId } = await ctx.params;
  try {
    await serviceInOrg(serviceId, auth.organizationId);
  } catch {
    return Response.json({ error: "Service not found" }, { status: 404 });
  }
  const id = await queueDeployment(serviceId, "api", { userId: auth.userId });
  return Response.json({ deploymentId: id }, { status: 202 });
}
