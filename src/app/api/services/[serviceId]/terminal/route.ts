import { cannotMessage } from "@/lib/permissions";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireOrg } from "@/server/auth";
import { serviceInOrg } from "@/server/services/access";
import { HOST_SHELL, hostShellRefused } from "@/server/services/console";
import { pickContainer } from "@/server/services/exec";
import { openSession } from "@/server/services/terminal";
import { logActivity } from "@/server/activity";
import { readJsonLimited } from "@/server/http-body";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  target: z.string().nullable().optional(),
  cols: z.number().int().min(10).max(500).default(80),
  rows: z.number().int().min(4).max(200).default(24),
});

/** Open an interactive shell in one of the service's running containers. */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/services/[serviceId]/terminal">) {
  const { serviceId } = await ctx.params;
  const org = await requireOrg();
  if (!org.can("console.access")) return new Response(cannotMessage("console.access"), { status: 403 });
  let service;
  try {
    service = (await serviceInOrg(serviceId, org.org.id)).service;
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Host mounts or privileged: a shell there is close to a shell on the host.
  if (hostShellRefused(service, org.isInstanceAdmin)) return NextResponse.json({ error: HOST_SHELL }, { status: 403 });
  const parsed = bodySchema.safeParse(await readJsonLimited(request, 65_536, {}));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  let container;
  try {
    container = await pickContainer(service, parsed.data.target);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }
  try {
    const session = await openSession({
      userId: org.user.id,
      scope: `service:${service.id}`,
      containerId: container.id,
      containerName: container.name,
      cols: parsed.data.cols,
      rows: parsed.data.rows,
      docker: container.docker,
    });
    await logActivity({
      userId: org.user.id,
      projectId: service.projectId,
      action: "service.terminal",
      targetType: "service",
      targetId: service.id,
      message: `Opened a terminal in ${service.name}`,
    });
    return NextResponse.json({ id: session.id, container: container.name });
  } catch (e) {
    return NextResponse.json({ error: `Could not start a shell: ${(e as Error).message}` }, { status: 500 });
  }
}
