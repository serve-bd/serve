import { notFound, requireToken, tokenService } from "@/server/api-auth";
import { queueDeployment } from "@/server/services/create";

/** Deploy the latest commit or image. Scope: deploy. */
export async function POST(request: Request, ctx: RouteContext<"/api/v1/services/[serviceId]/deploy">) {
  const { auth, error } = await requireToken(request, "deploy");
  if (error) return error;
  const { serviceId } = await ctx.params;
  const row = await tokenService(auth, serviceId);
  if (!row) return notFound("Service not found");
  const id = await queueDeployment(serviceId, "api", { userId: auth.userId });
  return Response.json({ deploymentId: id }, { status: 202 });
}
