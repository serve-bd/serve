import { NextResponse } from "next/server";
import { type OrgContext, requireOrg } from "@/server/auth";
import { canManageServer, canViewServer } from "./access";
import { getServer, getServerRow, type ServerCtx } from "./context";

/**
 * For server-scoped API routes: admins who manage the server (Root admins, or its organization's),
 * and it must exist. With `view`, also members who may see it read-only; `manage` tells which.
 */
export async function serverRoute(serverId: string, opts: { view?: boolean } = {}): Promise<{ admin: OrgContext; server: ServerCtx; manage: boolean } | { error: Response }> {
  const admin = await requireOrg().catch(() => null);
  const row = admin ? await getServerRow(serverId).catch(() => null) : null;
  const manage = !!admin && !!row && canManageServer(admin, row);
  if (!admin || (row && !manage && !(opts.view && canViewServer(admin, row))))
    return { error: NextResponse.json({ error: "Only admins who manage this server can do this." }, { status: 403 }) };
  if (!row) return { error: NextResponse.json({ error: "Server not found." }, { status: 404 }) };
  try {
    return { admin, server: await getServer(serverId), manage };
  } catch (e) {
    const message = (e as Error).message;
    return {
      error: NextResponse.json({ error: message === "Server not found." ? message : `Server unavailable: ${message}` }, { status: message === "Server not found." ? 404 : 503 }),
    };
  }
}
