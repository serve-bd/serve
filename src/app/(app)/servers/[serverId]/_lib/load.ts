import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { getServer, getServerRow } from "@/server/servers/context";
import { canManageServer, canViewServer } from "@/server/servers/access";

/** Server row + context for pages under /servers/[serverId]: Root admins, or admins of the organization that owns it. */
export const loadServer = cache(async (serverId: string) => {
  const ctx = await requireOrg();
  const row = await getServerRow(serverId).catch(() => null);
  if (!row) notFound();
  if (!canManageServer(ctx, row)) redirect("/");
  return { row, ctx, server: () => getServer(serverId) };
});

/**
 * Server row + context for pages everyone who may see the server opens (General, Metrics): its
 * managers, and members of organizations that own it or it is shared with. `manage` tells which.
 */
export const loadServerView = cache(async (serverId: string) => {
  const ctx = await requireOrg();
  const row = await getServerRow(serverId).catch(() => null);
  if (!row) notFound();
  const manage = canManageServer(ctx, row);
  if (!manage && !canViewServer(ctx, row)) redirect("/");
  return { row, ctx, manage, server: () => getServer(serverId) };
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
