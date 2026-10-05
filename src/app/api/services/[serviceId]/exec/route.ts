import { cannotMessage } from "@/lib/permissions";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireOrg } from "@/server/auth";
import { serviceInOrg } from "@/server/services/access";
import { execTargets, pickContainer } from "@/server/services/exec";
import { execResponse, HOST_SHELL, hostShellRefused } from "@/server/services/console";
import { logActivity } from "@/server/activity";
import { readJsonLimited } from "@/server/http-body";

export const dynamic = "force-dynamic";

/** Containers available for the console. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/services/[serviceId]/exec">) {
  const { serviceId } = await ctx.params;
  const org = await requireOrg();
  if (!org.can("console.access")) return new Response(cannotMessage("console.access"), { status: 403 });
  try {
    const { service } = await serviceInOrg(serviceId, org.org.id);
    return NextResponse.json({
      targets: (await execTargets(service)).map((t) => ({ name: t.name, composeService: t.composeService, key: t.key, server: t.server?.name ?? null })),
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

const bodySchema = z.object({ command: z.string().trim().min(1).max(4000), target: z.string().nullable().optional() });

/** Run a one-off command and stream its output as plain text. The last line is "\u0000<exit code>". */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/services/[serviceId]/exec">) {
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
  if (!parsed.success) return NextResponse.json({ error: "Enter a command" }, { status: 400 });
  let container;
  try {
    container = await pickContainer(service, parsed.data.target);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }
  await logActivity({
    userId: org.user.id,
    projectId: service.projectId,
    action: "service.exec",
    targetType: "service",
    targetId: service.id,
    message: `Ran \`${parsed.data.command.slice(0, 80)}\` in ${service.name}`,
  });

  return execResponse(container, parsed.data.command, request.signal);
}
