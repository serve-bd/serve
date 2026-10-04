"use server";

import { requireServerAdmin } from "@/server/servers/access";

import { eq } from "drizzle-orm";
import { act, UserError } from "@/server/action";
import { db, schema } from "@/server/db";

/** Status and setup log of a server, polled while it is validated. */
export async function getServerProgress(serverId: string) {
  return act(async () => {
    await requireServerAdmin(serverId);
    const [row] = await db
      .select({
        status: schema.server.status,
        statusMessage: schema.server.statusMessage,
        setupLog: schema.server.setupLog,
        info: schema.server.info,
        hostKey: schema.server.hostKey,
        tunnel: schema.server.tunnel,
        tailscale: schema.server.tailscale,
      })
      .from(schema.server)
      .where(eq(schema.server.id, serverId));
    if (!row) throw new UserError("Server not found.");
    // Only whether a server that connects out is connected; its keys and tokens stay here.
    const { tunnel, tailscale, ...rest } = row;
    return {
      ...rest,
      tunnel: tunnel ? { connectedAt: tunnel.connectedAt, joined: !!tunnel.clientKey } : null,
      tailscale: tailscale ? { joined: !!tailscale.joinedAt && !tailscale.tokenHash, address: tailscale.address } : null,
    };
  });
}
