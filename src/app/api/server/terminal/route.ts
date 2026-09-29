import os from "node:os";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireInstanceAdmin } from "@/server/auth";
import { openHostSession } from "@/server/services/terminal";
import { logActivity } from "@/server/activity";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  cols: z.number().int().min(10).max(500).default(80),
  rows: z.number().int().min(4).max(200).default(24),
});

/** Open a root shell on the host. Root organization admins only. */
export async function POST(request: NextRequest) {
  let ctx;
  try {
    ctx = await requireInstanceAdmin();
  } catch {
    return NextResponse.json({ error: "Only admins of the Root organization can open a host terminal." }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try {
    const session = await openHostSession({ userId: ctx.user.id, cols: parsed.data.cols, rows: parsed.data.rows });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.terminal", message: "Opened a host terminal" });
    return NextResponse.json({ id: session.id, container: os.hostname() });
  } catch (e) {
    return NextResponse.json({ error: `Could not start a host shell: ${(e as Error).message}` }, { status: 500 });
  }
}
