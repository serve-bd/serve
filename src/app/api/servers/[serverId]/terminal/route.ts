import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { openHostSession } from "@/server/services/terminal";
import { hostInfo } from "@/server/system";
import { logActivity } from "@/server/activity";
import { serverRoute } from "@/server/servers/route-auth";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  cols: z.number().int().min(10).max(500).default(80),
  rows: z.number().int().min(4).max(200).default(24),
});

/** Open a root shell on a server. Root organization admins only. */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/servers/[serverId]/terminal">) {
  const { serverId } = await ctx.params;
  const auth = await serverRoute(serverId);
  if ("error" in auth) return auth.error;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try {
    const session = await openHostSession({ userId: auth.admin.user.id, cols: parsed.data.cols, rows: parsed.data.rows, serverId });
    const name = auth.server.local ? (await hostInfo(auth.server)).name : auth.server.name;
    await logActivity({
      userId: auth.admin.user.id,
      organizationId: auth.admin.org.id,
      action: "server.terminal",
      message: auth.server.local ? "Opened a host terminal" : `Opened a terminal on ${auth.server.name}`,
    });
    return NextResponse.json({ id: session.id, container: name });
  } catch (e) {
    return NextResponse.json({ error: `Could not start a shell: ${(e as Error).message}` }, { status: 500 });
  }
}
