"use server";

import { eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requireInstanceAdmin } from "@/server/auth";
import { db, schema } from "@/server/db";
import { encrypt } from "@/server/crypto";
import { enqueue } from "@/server/queue";
import { logActivity } from "@/server/activity";
import { MESH_DEFAULT_PORT, MESH_MAX_SERVERS, meshEndpointProblem } from "@/lib/mesh";
import { generateMeshKeys } from "@/server/mesh/keys";

const meshInput = z.object({
  enabled: z.boolean(),
  endpoint: z.string().trim().max(253).optional(),
  port: z.number().int().min(1).max(65535).optional(),
});

/** Join or leave the private network, or change the address other servers use. */
export async function saveMesh(serverId: string, input: z.input<typeof meshInput>) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    const data = meshInput.parse(input);
    const saved = await db.transaction(async (tx) => {
      // One change at a time, so two servers never take the same slot.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('serve-mesh'))`);
      const [row] = await tx.select().from(schema.server).where(eq(schema.server.id, serverId));
      if (!row) throw new UserError("Server not found.");
      if (!data.enabled) {
        if (!row.mesh?.enabled) return row;
        await tx
          .update(schema.server)
          .set({ mesh: { ...row.mesh, enabled: false, state: "starting", message: null } })
          .where(eq(schema.server.id, serverId));
        return row;
      }
      if (!row.isLocal && row.status !== "ready") throw new UserError("Finish setting up this server first.");
      const endpoint = data.endpoint ?? row.mesh?.endpoint ?? "";
      const problem = meshEndpointProblem(endpoint);
      if (problem) throw new UserError(problem);
      const port = data.port ?? row.mesh?.port ?? MESH_DEFAULT_PORT;
      let index = row.meshIndex;
      if (index === null) {
        const used = new Set((await tx.select({ i: schema.server.meshIndex }).from(schema.server).where(isNotNull(schema.server.meshIndex))).map((r) => r.i));
        for (let i = 1; i <= MESH_MAX_SERVERS && index === null; i++) if (!used.has(i)) index = i;
        if (index === null) throw new UserError(`The private network holds up to ${MESH_MAX_SERVERS} servers.`);
      }
      const keys = row.mesh?.publicKey ? null : generateMeshKeys();
      const changed = !row.mesh?.enabled || row.mesh.endpoint !== endpoint.trim() || row.mesh.port !== port;
      await tx
        .update(schema.server)
        .set({
          meshIndex: index,
          mesh: {
            ...(row.mesh ?? {}),
            enabled: true,
            endpoint: endpoint.trim(),
            port,
            publicKey: keys?.publicKey ?? row.mesh!.publicKey,
            privateKey: keys ? encrypt(keys.privateKey) : row.mesh!.privateKey,
            state: changed ? "starting" : (row.mesh?.state ?? "starting"),
            message: changed ? null : (row.mesh?.message ?? null),
            configHash: changed ? null : (row.mesh?.configHash ?? null),
          },
        })
        .where(eq(schema.server.id, serverId));
      return row;
    });
    await enqueue("mesh.sync", {}, { concurrencyKey: "mesh" });
    const verb = !data.enabled ? "Removed" : saved.mesh?.enabled ? "Updated" : "Added";
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "server.update",
      message: `${verb} ${saved.name} ${data.enabled && saved.mesh?.enabled ? "in" : data.enabled ? "to" : "from"} the private network`,
    });
    return null;
  });
}

/** Rewrite every server's configuration now (after fixing a firewall, for example). */
export async function resyncMesh(serverId: string) {
  return act(async () => {
    await requireInstanceAdmin();
    const [row] = await db.select({ mesh: schema.server.mesh }).from(schema.server).where(eq(schema.server.id, serverId));
    if (!row?.mesh) throw new UserError("This server is not in the private network.");
    // Forget the last written configuration so the next run writes it again.
    await db
      .update(schema.server)
      .set({ mesh: { ...row.mesh, configHash: null } })
      .where(eq(schema.server.id, serverId));
    await enqueue("mesh.sync", {}, { concurrencyKey: "mesh" });
    return null;
  });
}
