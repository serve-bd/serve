"use server";

import { eq } from "drizzle-orm";
import { act, UserError } from "@/server/action";
import { requireInstanceAdmin } from "@/server/auth";
import { db, schema } from "@/server/db";

/** Status and setup log of a server, polled while it is validated. */
export async function getServerProgress(serverId: string) {
  return act(async () => {
    await requireInstanceAdmin();
    const [row] = await db
      .select({ status: schema.server.status, statusMessage: schema.server.statusMessage, setupLog: schema.server.setupLog, info: schema.server.info, hostKey: schema.server.hostKey })
      .from(schema.server)
      .where(eq(schema.server.id, serverId));
    if (!row) throw new UserError("Server not found.");
    return row;
  });
}
