"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { requireDeleteProof } from "@/server/delete-proof";
import { db, schema } from "@/server/db";
import { logActivity } from "@/server/activity";
import { VOLUME_NAME_RE } from "@/server/services/kept-data";

/** How long the server gets to remove the volume. */
const REMOVE_MS = 60_000;

/**
 * Delete data a deleted service left behind. The record is claimed first (removed in one step), so
 * a database starting on the same data at the same time cannot get it half deleted; it comes back
 * when the volume cannot be removed. Only Serve's own Docker volumes are removed: a host folder
 * or a volume made outside Serve is only forgotten.
 */
export async function deleteKeptData(kind: "database" | "volume", id: string, password?: string | null) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const k = z.enum(["database", "volume"]).parse(kind);
    const table = k === "database" ? schema.keptDatabase : schema.keptVolume;
    const [row] = await db
      .select({ id: table.id, serverId: table.serverId, projectId: table.projectId, volume: table.volume, owned: table.owned })
      .from(table)
      .where(and(eq(table.id, String(id)), eq(table.organizationId, ctx.org.id)));
    // Members limited to some projects only reach data of those projects.
    if (!row || (row.projectId ? !ctx.canAccessProject(row.projectId) : ctx.projectIds !== null)) throw new UserError("Kept data not found.");
    await requireDeleteProof(ctx, password);
    const folder = row.volume.startsWith("/");
    if (!folder && !VOLUME_NAME_RE.test(row.volume)) throw new UserError(`"${row.volume}" is not a Docker volume name. Nothing was deleted.`);

    const [claimed] = await db
      .delete(table)
      .where(and(eq(table.id, row.id), eq(table.organizationId, ctx.org.id)))
      .returning();
    if (!claimed) throw new UserError("Kept data not found.");
    const restore = () => db.insert(table).values(claimed as never);

    let note: string | null = null;
    if (folder) note = `Serve forgot this data. The folder stays at ${row.volume} on the server.`;
    else if (!row.owned) note = `Serve forgot this data. The volume ${row.volume} was made outside Serve and stays on the server.`;
    else {
      try {
        const { getServer } = await import("@/server/servers/context");
        const { withTimeout } = await import("@/server/monitoring/containers");
        const { docker } = await getServer(row.serverId);
        await withTimeout(
          docker
            .getVolume(row.volume)
            .remove()
            .catch((e: { statusCode?: number }) => {
              // Already gone: nothing left to delete.
              if (e?.statusCode !== 404) throw e;
            }),
          REMOVE_MS,
        );
      } catch (e) {
        await restore();
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 409) throw new UserError(`${row.volume} is already in use by a container. Remove that container first. Nothing was deleted.`);
        throw new UserError(`Could not delete ${row.volume}: ${e instanceof Error ? e.message : String(e)}. Nothing was deleted.`);
      }
    }
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      projectId: row.projectId,
      action: "kept-data.deleted",
      message: folder || !row.owned ? `Forgot kept data ${row.volume}` : `Deleted kept data ${row.volume}`,
    });
    return note ? { note } : null;
  });
}
