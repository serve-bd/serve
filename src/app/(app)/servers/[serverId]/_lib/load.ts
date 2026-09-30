import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { getServer, getServerRow } from "@/server/servers/context";
import { canManageServer } from "@/server/servers/access";

/** Server row + context for pages under /servers/[serverId]: Root admins, or admins of the organization that owns it. */
export const loadServer = cache(async (serverId: string) => {
  const ctx = await requireOrg();
  const row = await getServerRow(serverId).catch(() => null);
  if (!row) notFound();
  if (!canManageServer(ctx, row)) redirect("/");
  return { row, ctx, server: () => getServer(serverId) };
});

/** Runs a server call with a time limit, so an unreachable server never hangs a page. */
export async function withTimeout<T>(promise: Promise<T>, ms = 8000): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
