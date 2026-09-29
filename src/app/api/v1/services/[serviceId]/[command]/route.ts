import { notFound, requireToken, tokenService } from "@/server/api-auth";
import { requestServiceControl, type ServiceCommand } from "@/server/services/control";

const COMMANDS: ServiceCommand[] = ["start", "stop", "restart"];

/** POST /services/:id/start | stop | restart. Scope: deploy. */
export async function POST(request: Request, ctx: RouteContext<"/api/v1/services/[serviceId]/[command]">) {
  const { serviceId, command } = await ctx.params;
  if (!COMMANDS.includes(command as ServiceCommand)) return notFound();
  const { auth, error } = await requireToken(request, "deploy");
  if (error) return error;
  const row = await tokenService(auth, serviceId);
  if (!row) return notFound("Service not found");
  const result = await requestServiceControl(row.service, command as ServiceCommand, auth.userId);
  return Response.json({ ok: true, ...result }, { status: 202 });
}
