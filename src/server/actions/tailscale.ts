"use server";

import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { ForbiddenError, requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import type { ServerTailscale } from "@/server/db/schema";
import { decrypt, encrypt } from "@/server/crypto";
import { newId, slugify } from "@/server/id";
import { enqueue } from "@/server/queue";
import { logActivity } from "@/server/activity";
import { requireRoomForServer } from "@/server/limits";
import { generateKeyPair } from "@/server/servers/keys";
import { forgetServer } from "@/server/servers/context";
import { requireServerAdmin } from "@/server/servers/access";
import { newJoinToken } from "@/server/tunnel";
import { type TailscaleDevice, dnsSuffixOf, oauthToken, tailscaleClient } from "@/server/tailscale/api";
import { clientFor, getTailnet, pendingTailscale, recordTailnetCheck } from "@/server/tailscale";
import { JoinRefused, joinThroughShell } from "@/server/tailscale/join";

/* -------------------------------------------------------------------------- */
/*                                 Tailnets                                   */
/* -------------------------------------------------------------------------- */

/** Servers are the instance's, and so is the tailnet they join: Root admins only. */
async function requireTailscaleAdmin() {
  const ctx = await requireOrg();
  if (!ctx.isInstanceAdmin) throw new ForbiddenError("Only admins of the Root organization can manage Tailscale.");
  return ctx;
}

const TAG = /^tag:[a-z0-9][a-z0-9-]*$/i;

const tailnetInput = z.object({
  name: z.string().trim().max(60).optional(),
  /** "-" is the default tailnet of the credentials. */
  tailnet: z
    .string()
    .trim()
    .min(1, "Enter the tailnet name, or - for the default tailnet.")
    .max(253)
    .regex(/^(-|[A-Za-z0-9@._-]+)$/, "Enter the tailnet name as the admin console shows it (Settings, General), or -."),
  authType: z.enum(["oauth", "apikey"]),
  clientId: z.string().trim().max(200).optional(),
  /** OAuth client secret or API access key; empty on an edit keeps the stored one. */
  secret: z.string().trim().max(500).default(""),
  tag: z.string().trim().regex(TAG, "Use a tag like tag:serve.").default("tag:serve"),
});

type Verified = { devices: TailscaleDevice[]; accessToken: string | null; tokenExpiresAt: Date | null };

/**
 * Checks the credentials the way Serve will use them: list the devices, then make an auth key with
 * the tag (and remove it at once). The second catches a tag whose owner is not set in the policy,
 * or an OAuth client without that tag, which is the usual setup mistake.
 */
async function verify(data: { tailnet: string; authType: "oauth" | "apikey"; clientId: string | null; secret: string; tag: string }): Promise<Verified> {
  let accessToken: string | null = null;
  let tokenExpiresAt: Date | null = null;
  try {
    if (data.authType === "oauth") {
      const t = await oauthToken(data.clientId ?? "", data.secret);
      accessToken = t.token;
      tokenExpiresAt = t.expiresAt;
    }
    const client = tailscaleClient({
      tailnet: data.tailnet,
      renewable: false,
      token: async () => accessToken ?? data.secret,
    });
    const devices = await client.devices();
    const key = await client.createAuthKey({ tags: [data.tag], description: "Serve check", expirySeconds: 300 }).catch((error: Error) => {
      throw new UserError(
        `Tailscale lists the devices, but does not let Serve add any with ${data.tag}: ${error.message} Set the tag's owner in the tailnet policy${data.authType === "oauth" ? ", and give the OAuth client the auth_keys scope with this tag" : ""}.`,
      );
    });
    await client.deleteKey(key.id).catch(() => {});
    return { devices, accessToken, tokenExpiresAt };
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError((error as Error).message);
  }
}

export async function connectTailnet(input: z.input<typeof tailnetInput>) {
  return act(async () => {
    const ctx = await requireTailscaleAdmin();
    const data = tailnetInput.parse(input);
    if (!data.secret) throw new UserError(data.authType === "oauth" ? "Enter the client secret." : "Enter the API access key.");
    if (data.authType === "oauth" && !data.clientId) throw new UserError("Enter the client id.");
    if (data.authType === "apikey" && !data.secret.startsWith("tskey-api-"))
      throw new UserError("That is not an API access key (they start with tskey-api-). For an OAuth client, choose OAuth client.");
    const [same] = await db.select({ name: schema.tailscaleTailnet.name }).from(schema.tailscaleTailnet).where(eq(schema.tailscaleTailnet.tailnet, data.tailnet));
    if (same && data.tailnet !== "-") throw new UserError(`This tailnet is connected already as ${same.name}.`);
    const checked = await verify({ ...data, clientId: data.clientId ?? null });
    const suffix = checked.devices.map((d) => dnsSuffixOf(d.name)).find(Boolean) ?? null;
    const id = newId();
    const name = data.name || (data.tailnet !== "-" ? data.tailnet : (suffix ?? "Tailscale"));
    await db.insert(schema.tailscaleTailnet).values({
      id,
      name,
      tailnet: data.tailnet,
      authType: data.authType,
      clientId: data.authType === "oauth" ? (data.clientId ?? null) : null,
      secret: encrypt(data.secret),
      accessToken: checked.accessToken ? encrypt(checked.accessToken) : null,
      tokenExpiresAt: checked.tokenExpiresAt,
      tag: data.tag,
      dnsSuffix: suffix,
      checkedAt: new Date(),
    });
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "tailscale.connected",
      message: `Connected the tailnet ${name}`,
      targetType: "tailnet",
      targetId: id,
    });
    return { id, devices: checked.devices.length };
  });
}

/** New credentials or another tag for a tailnet; an empty secret keeps the stored one. Checked again. */
export async function updateTailnet(id: string, input: z.input<typeof tailnetInput>) {
  return act(async () => {
    const ctx = await requireTailscaleAdmin();
    const row = await getTailnet(id);
    if (!row) throw new UserError("Tailnet not found.");
    const data = tailnetInput.parse(input);
    if (data.authType !== row.authType && !data.secret) throw new UserError(data.authType === "oauth" ? "Enter the client secret." : "Enter the API access key.");
    if (data.authType === "oauth" && !data.clientId) throw new UserError("Enter the client id.");
    // A stored secret only goes with the client it was saved for.
    if (!data.secret && data.authType === "oauth" && data.clientId !== row.clientId) throw new UserError("Enter the client secret again: the client id changed.");
    const secret = data.secret || decrypt(row.secret);
    const checked = await verify({ ...data, clientId: data.clientId ?? null, secret });
    await db
      .update(schema.tailscaleTailnet)
      .set({
        name: data.name || row.name,
        tailnet: data.tailnet,
        authType: data.authType,
        clientId: data.authType === "oauth" ? (data.clientId ?? null) : null,
        secret: encrypt(secret),
        accessToken: checked.accessToken ? encrypt(checked.accessToken) : null,
        tokenExpiresAt: checked.tokenExpiresAt,
        tag: data.tag,
        error: null,
        checkedAt: new Date(),
      })
      .where(eq(schema.tailscaleTailnet.id, id));
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "tailscale.updated",
      message: `Updated the tailnet ${data.name || row.name}`,
      targetType: "tailnet",
      targetId: id,
    });
    return null;
  });
}

/** Calls the API now (list devices), so a revoked key or a deleted client shows. */
export async function testTailnet(id: string) {
  return act(async () => {
    await requireTailscaleAdmin();
    const row = await getTailnet(id);
    if (!row) throw new UserError("Tailnet not found.");
    try {
      const devices = await clientFor(row).devices();
      await recordTailnetCheck(id, null, devices);
      return `Tailscale answered: ${devices.length} device${devices.length === 1 ? "" : "s"} in the tailnet.`;
    } catch (error) {
      await recordTailnetCheck(id, (error as Error).message);
      throw new UserError((error as Error).message);
    }
  });
}

/**
 * Disconnect a tailnet. Servers keep running: one that has another way in (its address, or its
 * tunnel) goes back to it; one added through Tailscale shows as unreachable, saying why.
 */
export async function removeTailnet(id: string) {
  return act(async () => {
    const ctx = await requireTailscaleAdmin();
    const row = await getTailnet(id);
    if (!row) return null;
    const users = await db.select().from(schema.server).where(sql`${schema.server.tailscale}->>'tailnetId' = ${id}`);
    const client = clientFor(row);
    for (const s of users) {
      const ts = s.tailscale!;
      // An auth key made for a join that never finished must not outlive the integration.
      if (ts.authKeyId) await client.deleteKey(ts.authKeyId).catch(() => {});
      if (ts.only) {
        await db
          .update(schema.server)
          .set({
            tailscale: { ...ts, tailnetId: null, tokenHash: null, tokenExpiresAt: null, authKeyId: null },
            status: "unreachable",
            statusMessage: `Reached only through Tailscale, and the tailnet ${row.name} was disconnected from Serve. Connect Tailscale again, then connect this server through it.`,
          })
          .where(eq(schema.server.id, s.id));
      } else {
        await db.update(schema.server).set({ tailscale: null }).where(eq(schema.server.id, s.id));
        // Checked again the way it was reached before (its address, or its tunnel).
        if (!s.isLocal && ts.address) await enqueue("server.setup", { serverId: s.id }, { concurrencyKey: `server:${s.id}` });
      }
      forgetServer(s.id);
    }
    await db.delete(schema.tailscaleTailnet).where(eq(schema.tailscaleTailnet.id, id));
    if (users.some((s) => s.mesh?.enabled)) await enqueue("mesh.sync", {}, { concurrencyKey: "mesh" });
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "tailscale.removed",
      message: `Disconnected the tailnet ${row.name}`,
      targetType: "tailnet",
      targetId: id,
    });
    return null;
  });
}

/* -------------------------------------------------------------------------- */
/*                                  Servers                                   */
/* -------------------------------------------------------------------------- */

const joinCommand = (origin: string, token: string) => `curl -fsSL '${new URL(`/api/servers/join/tailscale/${token}`, origin).toString()}' | sudo bash`;

const origin = z
  .string()
  .url()
  .refine((o) => /^https?:$/.test(new URL(o).protocol), "Open the dashboard over http or https.");

/** A tailnet the instance's servers may join; an organization's servers stay public machines. */
async function tailnetForServer(tailnetId: string, server?: { ownerOrganizationId: string | null; name: string }) {
  if (server?.ownerOrganizationId)
    throw new UserError(`${server.name} belongs to an organization: its servers are reached at their public address, not through the instance's tailnet.`);
  const tailnet = await getTailnet(tailnetId);
  if (!tailnet) throw new UserError("That tailnet is no longer connected. Reload the page.");
  return tailnet;
}

/**
 * A server Serve reaches today must not move to an address the dashboard cannot reach: its
 * containers reach the tailnet through the host, so the host has to be in it first.
 */
async function requireLocalIn(tailnet: { id: string; name: string }) {
  const [local] = await db.select({ tailscale: schema.server.tailscale }).from(schema.server).where(eq(schema.server.isLocal, true));
  if (local?.tailscale?.tailnetId === tailnet.id && local.tailscale.address) return;
  throw new UserError(
    `The machine this dashboard runs on is not in ${tailnet.name} (as far as Serve knows), so it could not reach the server there. Add it first: Integrations, Tailscale, Add this server to the tailnet.`,
  );
}

const serverInput = z.object({
  name: z.string().trim().min(1, "Enter a name").max(60),
  username: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-z_][a-z0-9_.-]*$/i, "Enter a user name"),
  sshPort: z.number().int().min(1).max(65535),
  tailnetId: z.string().min(1),
  origin,
});

/** Add a server that Serve reaches only through Tailscale. It joins by running the returned command. */
export async function createTailscaleServer(input: z.input<typeof serverInput>) {
  return act(async () => {
    const ctx = await requireTailscaleAdmin();
    if (!ctx.isRoot) throw new UserError("Switch to the Root organization: servers in the tailnet belong to the instance.");
    const data = serverInput.parse(input);
    await requireRoomForServer(null);
    await tailnetForServer(data.tailnetId);
    const key = generateKeyPair(`serve-${data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
    const keyId = newId();
    const id = newId();
    const token = newJoinToken();
    await db.transaction(async (tx) => {
      await tx.insert(schema.privateKey).values({
        id: keyId,
        organizationId: null,
        name: `${data.name} key`,
        description: "Made for a server that connects through Tailscale; its join command authorizes it.",
        publicKey: key.publicKey,
        privateKey: encrypt(key.privateKey),
        fingerprint: key.fingerprint,
        createdBy: ctx.user.id,
      });
      await tx.insert(schema.server).values({
        id,
        name: data.name,
        // Its name until it joins, then its name in the tailnet.
        host: slugify(data.name, 63),
        port: data.sshPort,
        username: data.username,
        privateKeyId: keyId,
        ownerOrganizationId: null,
        organizationIds: [ctx.org.id],
        status: "pending",
        statusMessage: "Waiting for the server to join the tailnet",
        metricsEnabled: false,
        // Nothing on the internet reaches it: the proxy serves Cloudflare Tunnels without taking ports.
        proxyHttpPort: 0,
        proxyHttpsPort: 0,
        tailscale: pendingTailscale({ tailnetId: data.tailnetId, hostname: "", only: true, tokenHash: token.hash, tokenExpiresAt: token.expiresAt }),
      });
    });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.create", message: `Added server ${data.name} (through Tailscale)` });
    return { id, command: joinCommand(data.origin, token.token), expiresAt: token.expiresAt };
  });
}

/**
 * A join command that puts an existing server in a tailnet (or again, after it was reinstalled).
 * Until it ran, the server is reached as before.
 */
export async function tailscaleJoinCommand(serverId: string, tailnetId: string, originUrl: string) {
  return act(async () => {
    const { ctx, row } = await requireServerAdmin(serverId);
    if (!ctx.isInstanceAdmin) throw new ForbiddenError("Only admins of the Root organization can manage Tailscale.");
    if (row.isLocal) throw new UserError("The dashboard's own server joins with Add this server to the tailnet.");
    const tailnet = await tailnetForServer(tailnetId, row);
    if (!row.tailscale?.only) await requireLocalIn(tailnet);
    const at = origin.parse(originUrl);
    const token = newJoinToken();
    const ts: ServerTailscale =
      row.tailscale && row.tailscale.tailnetId === tailnet.id
        ? { ...row.tailscale, tokenHash: token.hash, tokenExpiresAt: token.expiresAt }
        : // Another (or no) tailnet before: reached as before (its address or tunnel) until it joined this one.
          { ...pendingTailscale({ tailnetId: tailnet.id, hostname: "", only: !!row.tailscale?.only, tokenHash: token.hash, tokenExpiresAt: token.expiresAt }) };
    await db.update(schema.server).set({ tailscale: ts }).where(eq(schema.server.id, serverId));
    forgetServer(serverId);
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.update", message: `Created a Tailscale join command for ${row.name}` });
    return { command: joinCommand(at, token.token), expiresAt: token.expiresAt };
  });
}

/**
 * Puts a server Serve reaches now in the tailnet by itself (over SSH, or on the dashboard's own
 * machine through the host). `force` moves a machine that is in another tailnet.
 */
export async function connectThroughTailscale(serverId: string, tailnetId: string, force = false) {
  return act(async () => {
    const { ctx, row } = await requireServerAdmin(serverId);
    if (!ctx.isInstanceAdmin) throw new ForbiddenError("Only admins of the Root organization can manage Tailscale.");
    const tailnet = await tailnetForServer(tailnetId, row);
    if (!row.isLocal && row.status !== "ready") throw new UserError(`${row.name} is not reachable right now. Use the join command instead and run it on the machine.`);
    if (!row.isLocal && !row.tailscale?.only) await requireLocalIn(tailnet);
    const before = row.tailscale;
    if (!before || before.tailnetId !== tailnet.id || !before.address)
      await db
        .update(schema.server)
        .set({ tailscale: pendingTailscale({ tailnetId: tailnet.id, hostname: "", only: !!before?.only, tokenHash: null, tokenExpiresAt: null }) })
        .where(eq(schema.server.id, serverId));
    try {
      const joined = await joinThroughShell(serverId, { force });
      await logActivity({
        userId: ctx.user.id,
        organizationId: ctx.org.id,
        action: "server.update",
        message: `Connected ${row.name} through Tailscale (${joined.address})`,
      });
      return { address: joined.address, moveNeeded: false };
    } catch (error) {
      // Nothing changed for how the server is reached.
      await db.update(schema.server).set({ tailscale: before }).where(eq(schema.server.id, serverId));
      forgetServer(serverId);
      if (error instanceof JoinRefused && /already in another tailnet/.test(error.message) && !force) {
        return { address: null, moveNeeded: true, message: error.message.split(" To move it")[0] };
      }
      throw new UserError((error as Error).message);
    }
  });
}

/**
 * Serve stops using the tailnet for this server and reaches it as before (its address or tunnel).
 * `removeDevice` also takes the machine out of the tailnet.
 */
export async function stopUsingTailscale(serverId: string, removeDevice = false) {
  return act(async () => {
    const { ctx, row } = await requireServerAdmin(serverId);
    if (!ctx.isInstanceAdmin) throw new ForbiddenError("Only admins of the Root organization can manage Tailscale.");
    const ts = row.tailscale;
    if (!ts) return null;
    if (ts.only && !row.isLocal)
      throw new UserError(`${row.name} was added through Tailscale and has no other address Serve could use. Remove the server instead, or give it a public address first.`);
    const tailnet = await getTailnet(ts.tailnetId);
    if (tailnet && ts.authKeyId)
      await clientFor(tailnet)
        .deleteKey(ts.authKeyId)
        .catch(() => {});
    if (removeDevice && ts.deviceId) {
      if (!tailnet) throw new UserError("The tailnet is no longer connected, so Serve cannot remove the device. Remove it in the Tailscale admin console.");
      await clientFor(tailnet)
        .deleteDevice(ts.deviceId)
        .catch((error: Error) => {
          throw new UserError(`${error.message} Remove it in the Tailscale admin console, or keep the device.`);
        });
    }
    await db.update(schema.server).set({ tailscale: null }).where(eq(schema.server.id, serverId));
    forgetServer(serverId);
    if (!row.isLocal && ts.address) await enqueue("server.setup", { serverId }, { concurrencyKey: `server:${serverId}` });
    if (row.mesh?.enabled) await enqueue("mesh.sync", {}, { concurrencyKey: "mesh" });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.update", message: `Stopped using Tailscale for ${row.name}` });
    return null;
  });
}
