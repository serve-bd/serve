import { NextResponse } from "next/server";
import { requireInstanceAdmin } from "@/server/auth";
import { getServer, type ServerCtx } from "./context";

type Admin = Awaited<ReturnType<typeof requireInstanceAdmin>>;

/** For server-scoped API routes: Root admins only, and the server must exist. */
export async function serverRoute(serverId: string): Promise<{ admin: Admin; server: ServerCtx } | { error: Response }> {
  const admin = await requireInstanceAdmin().catch(() => null);
  if (!admin) return { error: NextResponse.json({ error: "Only admins of the Root organization can manage servers." }, { status: 403 }) };
  try {
    return { admin, server: await getServer(serverId) };
  } catch (e) {
    const message = (e as Error).message;
    return { error: NextResponse.json({ error: message === "Server not found." ? message : `Server unavailable: ${message}` }, { status: message === "Server not found." ? 404 : 503 }) };
  }
}
