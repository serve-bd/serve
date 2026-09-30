"use server";

import { eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requireInstanceAdmin } from "@/server/auth";
import { db, schema } from "@/server/db";
import { encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { enqueue } from "@/server/queue";
import { logActivity } from "@/server/activity";
import { generateKeyPair } from "@/server/servers/keys";
import { forgetServer } from "@/server/servers/context";
import { allocateRelayPort, newJoinToken, tunnelPort } from "@/server/tunnel";

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$|^\d{1,3}(\.\d{1,3}){3}$/i;

const tunnelInput = z.object({
  name: z.string().trim().min(1, "Enter a name").max(60),
  username: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-z_][a-z0-9_.-]*$/i, "Enter a user name"),
  sshPort: z.number().int().min(1).max(65535),
  /** Address of this Serve machine the server connects to (public IP or host name). */
  address: z.string().trim().toLowerCase().regex(HOST, "Enter this Serve machine's public IP or host name"),
  /** The dashboard's address as the browser sees it: the join command downloads from it. */
  origin: z.string().url(),
});

const joinCommand = (origin: string, token: string) => `curl -fsSL '${new URL(`/api/servers/join/${token}`, origin).toString()}' | sudo bash`;

/** Add a server without a public address. It joins by running the returned command. */
export async function createTunnelServer(input: z.input<typeof tunnelInput>) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    const data = tunnelInput.parse(input);
    if (!/^https?:$/.test(new URL(data.origin).protocol)) throw new UserError("Open Serve over http or https.");
    const key = generateKeyPair(`serve-${data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
    const keyId = newId();
    const id = newId();
    const token = newJoinToken();
    await db.transaction(async (tx) => {
      const taken = new Set((await tx.select({ tunnel: schema.server.tunnel }).from(schema.server).where(isNotNull(schema.server.tunnel))).map((r) => r.tunnel!.relayPort));
      const relayPort = allocateRelayPort(taken);
      if (!relayPort) throw new UserError("No more servers can connect out.");
      await tx.insert(schema.privateKey).values({
        id: keyId,
        name: `${data.name} key`,
        description: "Made for a server that connects out; its join command authorizes it.",
        publicKey: key.publicKey,
        privateKey: encrypt(key.privateKey),
        fingerprint: key.fingerprint,
        createdBy: ctx.user.id,
      });
      await tx.insert(schema.server).values({
        id,
        name: data.name,
        // Replaced by the machine's own host name when it joins.
        host: "tunnel",
        port: data.sshPort,
        username: data.username,
        privateKeyId: keyId,
        status: "pending",
        statusMessage: "Waiting for the server to connect",
        tunnel: {
          relayPort,
          clientKey: null,
          tokenHash: token.hash,
          tokenExpiresAt: token.expiresAt,
          address: data.address,
          port: tunnelPort(),
          connectedAt: null,
          remote: null,
        },
      });
    });
    // The worker starts the listener (and publishes its port) now instead of within seconds.
    await enqueue("tunnel.sync", {}, { concurrencyKey: "tunnel" }).catch(() => {});
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.create", message: `Added server ${data.name} (connects out)` });
    return { id, command: joinCommand(data.origin, token.token), expiresAt: token.expiresAt };
  });
}

/** A new join command for a server that connects out (the old one stops working). */
export async function newJoinCommand(serverId: string, origin: string, address?: string) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    const [row] = await db.select().from(schema.server).where(eq(schema.server.id, serverId));
    if (!row?.tunnel) throw new UserError("This server does not connect out.");
    const next = address !== undefined ? tunnelInput.shape.address.parse(address) : row.tunnel.address;
    if (!/^https?:$/.test(new URL(z.string().url().parse(origin)).protocol)) throw new UserError("Open Serve over http or https.");
    const token = newJoinToken();
    await db
      .update(schema.server)
      .set({ tunnel: { ...row.tunnel, tokenHash: token.hash, tokenExpiresAt: token.expiresAt, address: next, port: tunnelPort() } })
      .where(eq(schema.server.id, serverId));
    forgetServer(serverId);
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.update", message: `Created a new join command for ${row.name}` });
    return { command: joinCommand(origin, token.token), expiresAt: token.expiresAt };
  });
}
