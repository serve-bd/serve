"use server";

import { count, eq } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requireInstanceAdmin } from "@/server/auth";
import { db, schema } from "@/server/db";
import { encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { enqueue } from "@/server/queue";
import { logActivity } from "@/server/activity";
import { generateKeyPair, parsePrivateKey } from "@/server/servers/keys";
import { forgetServer, getServer } from "@/server/servers/context";

/* -------------------------------------------------------------------------- */
/*                                Private keys                                */
/* -------------------------------------------------------------------------- */

const keySchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(60),
  description: z.string().trim().max(200).optional(),
  /** Paste an existing key; leave empty to generate a new ed25519 key. */
  privateKey: z.string().trim().max(20_000).optional(),
});

export async function createPrivateKey(input: z.input<typeof keySchema>) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    const data = keySchema.parse(input);
    const comment = `serve-${data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    let key;
    try {
      key = data.privateKey ? parsePrivateKey(data.privateKey, comment) : generateKeyPair(comment);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    const id = newId();
    await db.insert(schema.privateKey).values({
      id,
      name: data.name,
      description: data.description || null,
      publicKey: key.publicKey,
      privateKey: encrypt(key.privateKey),
      fingerprint: key.fingerprint,
      createdBy: ctx.user.id,
    });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "key.create", message: `Added SSH key ${data.name}` });
    return { id, publicKey: key.publicKey, fingerprint: key.fingerprint };
  });
}

export async function deletePrivateKey(id: string) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    const [{ n }] = await db.select({ n: count() }).from(schema.server).where(eq(schema.server.privateKeyId, id));
    if (n > 0) throw new UserError(`This key is used by ${n} server${n === 1 ? "" : "s"}. Give them another key first.`);
    const [key] = await db.delete(schema.privateKey).where(eq(schema.privateKey.id, id)).returning();
    if (key) await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "key.delete", message: `Deleted SSH key ${key.name}` });
    return null;
  });
}

/* -------------------------------------------------------------------------- */
/*                                   Servers                                  */
/* -------------------------------------------------------------------------- */

const host = z
  .string()
  .trim()
  .min(1, "Enter an IP address or hostname")
  .regex(/^[a-z0-9.:[\]-]+$/i, "Enter an IP address or hostname");

const serverSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(60),
  description: z.string().trim().max(200).nullable().optional(),
  host,
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(32).regex(/^[a-z_][a-z0-9_-]*$/i, "Enter a valid user name"),
  privateKeyId: z.string().min(1, "Choose an SSH key"),
  dataDir: z.string().trim().regex(/^\/[\w./-]+$/, "Use an absolute path like /data/serve"),
  publicIp: z.union([z.ipv4("Enter a valid IPv4 address"), z.literal("")]).nullable().optional(),
  wildcardDomain: z
    .union([z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Enter a valid domain"), z.literal("")])
    .nullable()
    .optional(),
  sslipFallback: z.boolean(),
  proxyHttpPort: z.number().int().min(1).max(65535),
  proxyHttpsPort: z.number().int().min(1).max(65535),
  organizationIds: z.array(z.string()).nullable(),
});

const empty = (v: string | null | undefined) => (v ? v : null);

export async function createServer(input: Pick<z.input<typeof serverSchema>, "name" | "description" | "host" | "port" | "username" | "privateKeyId"> & { dataDir?: string }) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    const data = serverSchema
      .pick({ name: true, description: true, host: true, port: true, username: true, privateKeyId: true, dataDir: true })
      .parse({ dataDir: "/data/serve", ...input });
    const id = newId();
    const looksLikeIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(data.host);
    await db.insert(schema.server).values({
      id,
      name: data.name,
      description: empty(data.description),
      host: data.host,
      port: data.port,
      username: data.username,
      privateKeyId: data.privateKeyId,
      dataDir: data.dataDir,
      publicIp: looksLikeIp ? data.host : null,
    });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.create", message: `Added server ${data.name} (${data.host})` });
    return { id };
  });
}

export async function updateServer(id: string, input: Partial<z.input<typeof serverSchema>>) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    const [before] = await db.select().from(schema.server).where(eq(schema.server.id, id));
    if (!before) throw new UserError("Server not found.");
    const data = serverSchema.partial().parse(input);
    if (before.isLocal && (data.host || data.port || data.username || data.privateKeyId || data.dataDir)) {
      throw new UserError("The connection of this server cannot change: Serve runs on it.");
    }
    // Current effective ports (the local server uses its environment until ports are saved here).
    const current = await getServer(id).catch(() => null);
    const httpPort = data.proxyHttpPort ?? current?.proxyHttpPort ?? before.proxyHttpPort;
    const httpsPort = data.proxyHttpsPort ?? current?.proxyHttpsPort ?? before.proxyHttpsPort;
    const portsChanged = (data.proxyHttpPort !== undefined || data.proxyHttpsPort !== undefined) && (httpPort !== current?.proxyHttpPort || httpsPort !== current?.proxyHttpsPort);
    if (portsChanged && httpPort === httpsPort) throw new UserError("HTTP and HTTPS need different ports.");
    const patch: Partial<typeof schema.server.$inferInsert> = {
      ...data,
      ...(portsChanged ? { proxyHttpPort: httpPort, proxyHttpsPort: httpsPort, proxyPortsCustomized: true } : { proxyHttpPort: undefined, proxyHttpsPort: undefined }),
      description: data.description === undefined ? undefined : empty(data.description),
      publicIp: data.publicIp === undefined ? undefined : empty(data.publicIp),
      wildcardDomain: data.wildcardDomain === undefined ? undefined : empty(data.wildcardDomain),
    };
    // A different machine means a different host key.
    if ((data.host && data.host !== before.host) || (data.port && data.port !== before.port)) patch.hostKey = null;
    await db.update(schema.server).set(patch).where(eq(schema.server.id, id));
    forgetServer(id);

    const connectionChanged = ["host", "port", "username", "privateKeyId", "dataDir"].some((k) => k in data && data[k as keyof typeof data] !== before[k as keyof typeof before]);
    if (connectionChanged && !before.isLocal) await enqueue("server.setup", { serverId: id }, { concurrencyKey: `server:${id}` });
    if (portsChanged && (before.isLocal || before.status === "ready")) {
      // Recreate the proxy on the new ports now, so a busy port is reported here and nothing changes.
      const { ensureServerProxy } = await import("@/server/proxy/nginx");
      try {
        await ensureServerProxy(await getServer(id));
      } catch (error) {
        await db
          .update(schema.server)
          .set({ proxyHttpPort: before.proxyHttpPort, proxyHttpsPort: before.proxyHttpsPort, proxyPortsCustomized: before.proxyPortsCustomized })
          .where(eq(schema.server.id, id));
        forgetServer(id);
        throw new UserError((error as Error).message);
      }
    }
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.update", message: `Updated server ${data.name ?? before.name}` });
    return null;
  });
}

/** Connects, checks Docker (optionally installs it) and starts the proxy. */
export async function validateServer(id: string, opts: { installDocker?: boolean } = {}) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    const [row] = await db.select().from(schema.server).where(eq(schema.server.id, id));
    if (!row) throw new UserError("Server not found.");
    if (row.isLocal) throw new UserError("This server is always connected.");
    await db.update(schema.server).set({ status: "validating", statusMessage: "Queued", setupLog: "" }).where(eq(schema.server.id, id));
    await enqueue("server.setup", { serverId: id, installDocker: opts.installDocker === true }, { concurrencyKey: `server:${id}` });
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "server.validate",
      message: opts.installDocker ? `Started Docker installation on ${row.name}` : `Validated server ${row.name}`,
    });
    return null;
  });
}

/** Forgets the pinned SSH host key (after reinstalling the server). */
export async function resetHostKey(id: string) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    const [row] = await db.update(schema.server).set({ hostKey: null }).where(eq(schema.server.id, id)).returning();
    if (!row) throw new UserError("Server not found.");
    forgetServer(id);
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.update", message: `Reset the SSH host key of ${row.name}` });
    return null;
  });
}

export async function deleteServer(id: string) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    const [row] = await db.select().from(schema.server).where(eq(schema.server.id, id));
    if (!row) throw new UserError("Server not found.");
    if (row.isLocal) throw new UserError("The server Serve runs on cannot be removed.");
    const [{ n }] = await db.select({ n: count() }).from(schema.service).where(eq(schema.service.serverId, id));
    if (n > 0) throw new UserError(`${n} service${n === 1 ? " runs" : "s run"} on this server. Move or delete ${n === 1 ? "it" : "them"} first.`);
    await db.delete(schema.server).where(eq(schema.server.id, id));
    forgetServer(id);
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.delete", message: `Removed server ${row.name}` });
    return null;
  });
}
