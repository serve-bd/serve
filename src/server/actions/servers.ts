"use server";

import { and, count, eq, inArray, ne, or, sql } from "drizzle-orm";
import { requireDeleteProof } from "@/server/delete-proof";
import { runsAsExtraOn } from "@/server/services/distribution-query";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { ownerFor, requireServerAdmin, requireServerCreator, serverFitsNetwork, serversForOrg, setDefaultServer } from "@/server/servers/access";
import { ForbiddenError, type OrgContext, requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { requireRoomForServer } from "@/server/limits";
import { encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { enqueue } from "@/server/queue";
import { logActivity } from "@/server/activity";
import { generateKeyPair, parsePrivateKey } from "@/server/servers/keys";
import { forgetServer, getServer } from "@/server/servers/context";
import { publicAddress } from "@/server/net/public-host";
import { domainOwnership, ownershipMessage } from "@/server/domains/ownership";

/* -------------------------------------------------------------------------- */
/*                                Private keys                                */
/* -------------------------------------------------------------------------- */

const keySchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(60),
  description: z.string().trim().max(200).optional(),
  /** Paste an existing key; leave empty to generate a new ed25519 key. */
  privateKey: z.string().trim().max(20_000).optional(),
});

/** SSH key comment from a name: the name itself, safe for one line of authorized_keys. */
function keyComment(name: string) {
  return (
    name
      .trim()
      .replace(/[^\w.@+-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "key"
  );
}

/** Keys a server of `owner` may use: its organization's own, or the instance's for Root admins. */
async function usableKey(ctx: Pick<OrgContext, "isInstanceAdmin">, keyId: string, owner: string | null) {
  const [key] = await db.select({ organizationId: schema.privateKey.organizationId }).from(schema.privateKey).where(eq(schema.privateKey.id, keyId));
  if (!key) throw new UserError("SSH key not found.");
  if (key.organizationId !== owner && !(key.organizationId === null && ctx.isInstanceAdmin)) throw new UserError("This SSH key belongs to another organization.");
}

export async function createPrivateKey(input: z.input<typeof keySchema>) {
  return act(async () => {
    const ctx = await requireServerCreator();
    const data = keySchema.parse(input);
    // The public key's comment is the name as typed; spaces and odd characters become dashes.
    const comment = keyComment(data.name);
    let key;
    try {
      key = data.privateKey ? parsePrivateKey(data.privateKey, comment) : generateKeyPair(comment);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    const id = newId();
    await db.insert(schema.privateKey).values({
      id,
      organizationId: ownerFor(ctx),
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
    const ctx = await requireServerCreator();
    const [owned] = await db.select({ organizationId: schema.privateKey.organizationId }).from(schema.privateKey).where(eq(schema.privateKey.id, id));
    if (!owned) return null;
    if (!ctx.isInstanceAdmin && owned.organizationId !== ctx.org.id) throw new ForbiddenError("This SSH key belongs to another organization.");
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
  username: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-z_][a-z0-9_-]*$/i, "Enter a valid user name"),
  privateKeyId: z.string().min(1, "Choose an SSH key"),
  dataDir: z
    .string()
    .trim()
    .regex(/^\/[\w./-]+$/, "Use an absolute path like /data/serve"),
  publicIp: z
    .union([z.ipv4("Enter a valid IPv4 address"), z.literal("")])
    .nullable()
    .optional(),
  wildcardDomain: z
    .union([
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Enter a valid domain"),
      z.literal(""),
    ])
    .nullable()
    .optional(),
  sslipFallback: z.boolean(),
  /** 0: the proxy takes no port on the machine (Cloudflare Tunnels still reach it). */
  proxyHttpPort: z.number().int().min(0).max(65535),
  proxyHttpsPort: z.number().int().min(0).max(65535),
  organizationIds: z.array(z.string()).nullable(),
  /** Root admins only: hand the server to an organization, or back to the instance (null). */
  ownerOrganizationId: z.string().nullable(),
  buildConcurrency: z.number().int().min(1, "At least 1 build").max(1000),
  /** Minutes; null for Serve's default. */
  deployTimeoutMinutes: z.number().int().min(5, "At least 5 minutes").max(10080).nullable(),
  /** Waiting deployments; null for no limit. */
  deployQueueLimit: z.number().int().min(1, "At least 1").max(100_000).nullable(),
  imageRetention: z.number().int().min(1, "Keep at least 1 image").max(50),
  metricsRetentionHours: z
    .number()
    .int()
    .min(1, "Keep at least 1 hour")
    .max(24 * 30, "At most 30 days"),
  metricsEnabled: z.boolean(),
});

const empty = (v: string | null | undefined) => (v ? v : null);

export async function createServer(input: Pick<z.input<typeof serverSchema>, "name" | "description" | "host" | "port" | "username" | "privateKeyId"> & { dataDir?: string }) {
  return act(async () => {
    const ctx = await requireServerCreator();
    const data = serverSchema
      .pick({ name: true, description: true, host: true, port: true, username: true, privateKeyId: true, dataDir: true })
      .parse({ dataDir: "/data/serve", ...input });
    const owner = ownerFor(ctx);
    await requireRoomForServer(owner);
    if (owner) await assertPublicHost(data.host);
    await usableKey(ctx, data.privateKeyId, owner);
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
      // An organization's server is its own; an instance server starts with Root only, and Root admins share it.
      ownerOrganizationId: owner,
      organizationIds: owner ? [] : [ctx.org.id],
      // Metrics are opt-in on added servers: the agent runs only once someone turns them on.
      metricsEnabled: false,
    });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.create", message: `Added server ${data.name} (${data.host})` });
    return { id };
  });
}

export async function updateServer(id: string, input: Partial<z.input<typeof serverSchema>>) {
  return act(async () => {
    const { ctx, row: before } = await requireServerAdmin(id);
    const data = serverSchema.partial().parse(input);
    if ((data.organizationIds !== undefined || data.ownerOrganizationId !== undefined) && !ctx.isInstanceAdmin) {
      throw new ForbiddenError("Only admins of the Root organization can share a server or change its owner.");
    }
    const ownerChanged = data.ownerOrganizationId !== undefined && data.ownerOrganizationId !== before.ownerOrganizationId;
    let moveKey: string | null = null;
    if (ownerChanged) {
      if (before.isLocal && data.ownerOrganizationId) throw new UserError("The server the dashboard runs on stays with the instance.");
      if (data.ownerOrganizationId) {
        const [org] = await db.select({ id: schema.organization.id }).from(schema.organization).where(eq(schema.organization.id, data.ownerOrganizationId));
        if (!org) throw new UserError("Organization not found.");
        // The new owner gets root on the machine: nothing of another organization may stay on it.
        // An organization's server is reached at its public address, never through the instance's tailnet.
        if (before.tailscale)
          throw new UserError(
            "This server is in the instance's tailnet. Stop using Tailscale for it first (on its page); an organization's server is reached at its public address.",
          );
        const foreign = await foreignWorkOn(id, data.ownerOrganizationId);
        if (foreign.length) throw new UserError(`Move these off the server first; they belong to other organizations: ${foreign.join(", ")}.`);
        if (!before.tunnel) await assertPublicHost(data.host ?? before.host);
      }
      // Its key moves with it, so the new owner can manage it; a key other servers use must stay.
      const keyId = data.privateKeyId ?? before.privateKeyId;
      if (keyId) {
        const [key] = await db.select({ organizationId: schema.privateKey.organizationId }).from(schema.privateKey).where(eq(schema.privateKey.id, keyId));
        if (key && key.organizationId !== data.ownerOrganizationId) {
          const others = await db
            .select({ name: schema.server.name })
            .from(schema.server)
            .where(and(eq(schema.server.privateKeyId, keyId), ne(schema.server.id, id)));
          if (others.length) throw new UserError(`Its SSH key is also used by ${others.map((o) => o.name).join(", ")}. Give this server its own key first.`);
          moveKey = keyId;
        }
      }
    }
    if (data.privateKeyId && data.privateKeyId !== before.privateKeyId) {
      await usableKey(ctx, data.privateKeyId, data.ownerOrganizationId === undefined ? before.ownerOrganizationId : data.ownerOrganizationId);
    }
    // An instance key may open other machines: only instance admins point it at a new address.
    const moved = (data.host && data.host !== before.host) || (data.port && data.port !== before.port) || (data.username && data.username !== before.username);
    const signInKey = data.privateKeyId ?? before.privateKeyId;
    if (moved && !ctx.isInstanceAdmin && signInKey) {
      const [key] = await db.select({ organizationId: schema.privateKey.organizationId }).from(schema.privateKey).where(eq(schema.privateKey.id, signInKey));
      if (key && key.organizationId !== before.ownerOrganizationId)
        throw new UserError("This server signs in with an SSH key of the instance. Choose a key of your organization first.");
    }
    if (data.host && data.host !== before.host && !ownerChanged && before.ownerOrganizationId && !before.tunnel) {
      await assertPublicHost(data.host);
    }
    if (before.isLocal && (data.host || data.port || data.username || data.privateKeyId || data.dataDir)) {
      throw new UserError("The connection of this server cannot change: the dashboard runs on it.");
    }
    // Names under a server's wildcard need no proof later: other organizations than Root prove it first.
    if (data.wildcardDomain && data.wildcardDomain !== before.wildcardDomain && !ctx.isInstanceAdmin) {
      const wildcard = `*.${data.wildcardDomain}`;
      const ownership = await domainOwnership({ id: ctx.org.id, isRoot: false }, wildcard);
      if (!ownership.verified) throw new UserError(ownershipMessage(wildcard, ownership));
    }
    // Current effective ports (the local server uses its environment until ports are saved here).
    const current = await getServer(id).catch(() => null);
    const httpPort = data.proxyHttpPort ?? current?.proxyHttpPort ?? before.proxyHttpPort;
    const httpsPort = data.proxyHttpsPort ?? current?.proxyHttpsPort ?? before.proxyHttpsPort;
    const portsChanged = (data.proxyHttpPort !== undefined || data.proxyHttpsPort !== undefined) && (httpPort !== current?.proxyHttpPort || httpsPort !== current?.proxyHttpsPort);
    if (portsChanged && httpPort === httpsPort && httpPort !== 0) throw new UserError("HTTP and HTTPS need different ports.");
    // With a proxy on the machine trusted, the proxy answers on 127.0.0.1 only: on 80/443 nothing could be in front of it.
    if (portsChanged && before.trustedProxies?.machine && (httpPort === 80 || httpsPort === 443))
      throw new UserError("Visitor IP trusts a proxy on this machine, which must own ports 80 and 443. Turn that off in Visitor IP first, or keep other ports.");
    const patch: Partial<typeof schema.server.$inferInsert> = {
      ...data,
      ...(portsChanged ? { proxyHttpPort: httpPort, proxyHttpsPort: httpsPort, proxyPortsCustomized: true } : { proxyHttpPort: undefined, proxyHttpsPort: undefined }),
      description: data.description === undefined ? undefined : empty(data.description),
      publicIp: data.publicIp === undefined ? undefined : empty(data.publicIp),
      wildcardDomain: data.wildcardDomain === undefined ? undefined : empty(data.wildcardDomain),
    };
    const dnsAccount = before.proxyConfig?.traefik?.acmeChallenge === "dns-cloudflare" && !!before.proxyConfig.traefik.cloudflareAccountId;
    if (ownerChanged) {
      // An organization's server is shared with nobody; back with the instance, it is shared as chosen and its old owner keeps deploying to it.
      if (data.ownerOrganizationId) patch.organizationIds = [];
      else {
        const chosen = data.organizationIds !== undefined ? data.organizationIds : before.organizationIds;
        patch.organizationIds = chosen === null ? null : [...new Set([...chosen, ...(before.ownerOrganizationId ? [before.ownerOrganizationId] : [])])];
      }
      // The old owner's Cloudflare account no longer issues its certificates.
      if (dnsAccount) patch.proxyConfig = { ...before.proxyConfig, traefik: { ...before.proxyConfig!.traefik, acmeChallenge: "http", cloudflareAccountId: null } };
    }
    // A different machine means a different host key.
    if ((data.host && data.host !== before.host) || (data.port && data.port !== before.port)) patch.hostKey = null;
    if (ownerChanged && before.status !== "pending") {
      // The new owner gets root on the machine: the old owner's token and certificates leave it first.
      const { clearProxyForNewOwner, ensureServerProxy } = await import("@/server/proxy/nginx");
      const target = await getServer(id).catch(() => null);
      if (!target) throw new UserError(`${before.name} could not be reached to clear its proxy. Try again when it is online.`);
      try {
        await clearProxyForNewOwner(target);
      } catch (e) {
        // The owner stays the same: bring its proxy back at once, so its sites stay online.
        void ensureServerProxy(target).catch(() => {});
        throw new UserError(`Could not clear the proxy of ${before.name}: ${(e as Error).message}. Try again when it is online.`);
      }
    }
    await db.transaction(async (tx) => {
      await tx.update(schema.server).set(patch).where(eq(schema.server.id, id));
      // Its key moves with it, so the new owner can manage it.
      if (moveKey)
        await tx
          .update(schema.privateKey)
          .set({ organizationId: data.ownerOrganizationId ?? null })
          .where(eq(schema.privateKey.id, moveKey));
    });
    forgetServer(id);
    const sharingChanged = data.organizationIds !== undefined && JSON.stringify(data.organizationIds) !== JSON.stringify(before.organizationIds);
    if (ownerChanged || sharingChanged) {
      // It leaves private networks of organizations it no longer belongs to or is shared with.
      const [after] = await db.select().from(schema.server).where(eq(schema.server.id, id));
      const joined = await db
        .select({ networkId: schema.privateNetworkMember.networkId, organizationId: schema.privateNetwork.organizationId })
        .from(schema.privateNetworkMember)
        .innerJoin(schema.privateNetwork, eq(schema.privateNetwork.id, schema.privateNetworkMember.networkId))
        .where(eq(schema.privateNetworkMember.serverId, id));
      const stale = joined.filter((n) => !serverFitsNetwork(n, after)).map((n) => n.networkId);
      const left = stale.length
        ? await db
            .delete(schema.privateNetworkMember)
            .where(and(eq(schema.privateNetworkMember.serverId, id), inArray(schema.privateNetworkMember.networkId, stale)))
            .returning({ networkId: schema.privateNetworkMember.networkId })
        : [];
      if (left.length) await enqueue("mesh.sync", {}, { concurrencyKey: "mesh" });
      // Its proxy was removed above: start it again for the new owner.
      if (ownerChanged && before.status === "ready") {
        const { ensureServerProxy } = await import("@/server/proxy/nginx");
        await getServer(id)
          .then((c) => ensureServerProxy(c))
          .catch(() => {});
      }
    }

    if (data.metricsEnabled !== undefined && data.metricsEnabled !== before.metricsEnabled && !before.isLocal && before.status === "ready") {
      // Start or remove the agent now instead of on the worker's next round; it can take a while.
      const { ensureMetricsAgent, removeMetricsAgent } = await import("@/server/metrics-agent");
      void getServer(id)
        .then(async (c) => {
          if (data.metricsEnabled) await ensureMetricsAgent(c);
          else await removeMetricsAgent(c);
        })
        .catch(() => {});
    }
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

/** An organization's server must be a public machine; one without a public address connects out instead. */
async function assertPublicHost(host: string) {
  if (!(await publicAddress(host))) throw new UserError("That address is private or does not resolve. Use the server's public address, or add it as a server that connects out.");
}

/** Services, tunnels and certificates on a server that belong to organizations other than `orgId`. */
async function foreignWorkOn(serverId: string, orgId: string) {
  const [services, tunnels, certificates] = await Promise.all([
    db
      .select({ name: schema.service.name })
      .from(schema.service)
      .innerJoin(schema.project, eq(schema.project.id, schema.service.projectId))
      .where(
        and(
          or(eq(schema.service.serverId, serverId), runsAsExtraOn(serverId), sql`${schema.service.distribution}->>'buildServerId' = ${serverId}`),
          ne(schema.project.organizationId, orgId),
        ),
      ),
    db
      .select({ name: schema.cloudflareTunnel.name })
      .from(schema.cloudflareTunnel)
      .where(and(eq(schema.cloudflareTunnel.serverId, serverId), ne(schema.cloudflareTunnel.organizationId, orgId))),
    db
      .select({ name: schema.certificate.name })
      .from(schema.certificate)
      .where(and(eq(schema.certificate.serverId, serverId), ne(schema.certificate.organizationId, orgId))),
  ]);
  return [...services.map((r) => r.name), ...tunnels.map((r) => `tunnel ${r.name}`), ...certificates.map((r) => `certificate ${r.name}`)];
}

/** Connects, checks Docker (optionally installs it) and starts the proxy. */
export async function validateServer(id: string, opts: { installDocker?: boolean } = {}) {
  return act(async () => {
    const { ctx, row } = await requireServerAdmin(id);
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
    const { ctx } = await requireServerAdmin(id);
    const [row] = await db.update(schema.server).set({ hostKey: null }).where(eq(schema.server.id, id)).returning();
    if (!row) throw new UserError("Server not found.");
    forgetServer(id);
    // Nothing connects until the key is pinned again: the setup run does that now.
    if (!row.isLocal) await enqueue("server.setup", { serverId: id }, { concurrencyKey: `server:${id}` });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.update", message: `Reset the SSH host key of ${row.name}` });
    return null;
  });
}

/** `removeTailnetDevice`: also take the machine out of the tailnet it joined through Serve. */
/**
 * Remove a server. With services on it, `services` says what happens to them: "stop" deletes them
 * and their containers (with their data when `removeData`), "keep" leaves them running on the
 * machine while Serve forgets them (the proxy stays too, so their domains keep working).
 */
export async function deleteServer(
  id: string,
  opts: { removeTailnetDevice?: boolean; services?: "stop" | "keep"; removeData?: boolean; removeProxy?: boolean; removeTunnels?: boolean; password?: string | null } = {},
) {
  return act(async () => {
    const { ctx, row } = await requireServerAdmin(id);
    if (row.isLocal) throw new UserError("The server the dashboard runs on cannot be removed.");
    const onServer = await db.select().from(schema.service).where(eq(schema.service.serverId, id));
    const n = onServer.length;
    if (n > 0 && !opts.services) throw new UserError(`${n} service${n === 1 ? " runs" : "s run"} on this server. Choose whether to stop them or keep them running.`);
    const extraOf = await db
      .select({ name: schema.service.name })
      .from(schema.service)
      .where(or(runsAsExtraOn(id), sql`${schema.service.distribution}->>'buildServerId' = ${id}`));
    // A read replica here of a database that runs elsewhere would be left pointing at no server.
    const replicaOf = await db
      .select({ name: schema.service.name })
      .from(schema.service)
      .where(
        and(
          ne(schema.service.serverId, id),
          sql`coalesce(${schema.service.database}->'replica'->'instances', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('serverId', ${id}::text))`,
        ),
      );
    if (replicaOf.length) {
      throw new UserError(
        `${replicaOf.map((s) => s.name).join(", ")} ${replicaOf.length === 1 ? "has a read replica" : "have read replicas"} on this server. Remove ${replicaOf.length === 1 ? "it" : "them"} in the database settings first.`,
      );
    }
    if (extraOf.length) {
      throw new UserError(
        `${extraOf.map((s) => s.name).join(", ")} ${extraOf.length === 1 ? "uses" : "use"} this server to build or run. Remove it in their Servers & registry settings first.`,
      );
    }
    await requireDeleteProof(ctx, opts.password);
    if (row.mesh && row.mesh.state !== "off") {
      // Take the private network down there while Serve can still reach the server.
      const { teardownMesh } = await import("@/server/mesh");
      await Promise.race([getServer(id).then(teardownMesh), new Promise((r) => setTimeout(r, 30_000))]).catch(() => {});
    }
    if (row.agent) {
      const { removeMetricsAgent } = await import("@/server/metrics-agent");
      await Promise.race([getServer(id).then(removeMetricsAgent), new Promise((r) => setTimeout(r, 30_000))]).catch(() => {});
    }
    if (row.tailscale) {
      const { clientFor, getTailnet } = await import("@/server/tailscale");
      const tailnet = await getTailnet(row.tailscale.tailnetId);
      const client = tailnet ? clientFor(tailnet) : null;
      // Checked first: a device that could not be removed keeps the server, so nothing is half done.
      if (opts.removeTailnetDevice && row.tailscale.deviceId) {
        if (!client)
          throw new UserError("The tailnet is no longer connected, so Serve cannot remove the device. Remove it in the Tailscale admin console, or remove the server without it.");
        await client.deleteDevice(row.tailscale.deviceId).catch((error: Error) => {
          throw new UserError(`${error.message} Remove the server without removing the device, then remove it in the Tailscale admin console.`);
        });
      }
      // An auth key made for a join that never finished must not stay valid.
      if (client && row.tailscale.authKeyId) await client.deleteKey(row.tailscale.authKeyId).catch(() => {});
    }
    if (n > 0) {
      const { teardownServices } = await import("@/server/services/teardown");
      // Stopped now, while Serve can still reach the server; kept ones are only forgotten.
      await teardownServices(onServer, !!opts.removeData, opts.services === "keep" ? { leaveRunning: true } : { inline: true });
    }
    // Serve's own containers there (the proxy and its helpers, the log collector), unless kept
    // services still answer through the proxy. The server's files and other containers stay.
    // With services kept running, the proxy and the tunnels go too unless asked to stay (the owner
    // usually puts their own in place).
    const keepProxy = opts.services === "keep" && opts.removeProxy === false;
    const keepTunnels = opts.services === "keep" && opts.removeTunnels === false;
    if (!keepProxy) await Promise.race([getServer(id).then(removeServeContainers), new Promise((r) => setTimeout(r, 30_000))]).catch(() => {});
    // Its tunnels go too: the connector stops there and the tunnel is deleted on Cloudflare.
    const tunnels = await db.select({ id: schema.cloudflareTunnel.id }).from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.serverId, id));
    if (tunnels.length && !keepTunnels) {
      const { deleteTunnel } = await import("@/server/cloudflare/tunnels");
      await Promise.all(tunnels.map((t) => deleteTunnel(t.id).catch(() => {})));
    }
    await db.delete(schema.server).where(eq(schema.server.id, id));
    forgetServer(id);
    if (row.mesh?.enabled) await enqueue("mesh.sync", {}, { concurrencyKey: "mesh" });
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "server.delete",
      message: n
        ? `Removed server ${row.name} and ${opts.services === "keep" ? "forgot" : "deleted"} its ${n} service${n === 1 ? "" : "s"}${opts.services === "keep" ? " (still running there)" : ""}`
        : `Removed server ${row.name}`,
    });
    return null;
  });
}

/** Checks the server for operating system updates (in the background). Installs nothing. */
export async function checkOsUpdatesAction(serverId: string) {
  return act(async () => {
    await requireServerAdmin(serverId);
    const { enqueue } = await import("@/server/queue");
    await enqueue("server.os-updates", { serverId, op: "check" }, { concurrencyKey: `server-os:${serverId}` });
    return null;
  });
}

/** Installs updates: "all" (without Docker's packages) or the named packages. */
export async function installOsUpdatesAction(serverId: string, what: "all" | string[]) {
  return act(async () => {
    const { row } = await requireServerAdmin(serverId);
    const list = what === "all" ? "all" : z.array(z.string().max(128)).min(1).max(2000).parse(what);
    if (row.osUpdates?.run?.state === "running") throw new UserError("Updates are being installed already.");
    const { DOCKER_PACKAGE } = await import("@/server/servers/os-updates");
    if (row.isLocal && list !== "all" && list.some((n) => DOCKER_PACKAGE.test(n)))
      throw new UserError("Docker's packages cannot be updated from here on this server: it would stop Serve itself. Update them in a terminal on the host.");
    if (row.osUpdates?.manager === "pacman" && list !== "all") throw new UserError("Arch Linux updates everything at once: use Update all.");
    // Shown as running right away; the job fills in the log.
    await db
      .update(schema.server)
      .set({
        osUpdates: row.osUpdates
          ? { ...row.osUpdates, run: { state: "running", startedAt: new Date().toISOString(), finishedAt: null, what: list, error: null, log: "Waiting to start…\n" } }
          : row.osUpdates,
      })
      .where(eq(schema.server.id, serverId));
    const { enqueue } = await import("@/server/queue");
    await enqueue("server.os-updates", { serverId, op: "install", what: list }, { concurrencyKey: `server-os:${serverId}` });
    return null;
  });
}

/** Make a server the organization's default: new services go there unless someone picks another. */
export async function makeDefaultServer(serverId: string) {
  return act(async () => {
    const ctx = await requireOrg();
    if (!ctx.isAdmin) throw new ForbiddenError("Only admins of the organization choose its default server.");
    const server = (await serversForOrg(ctx.org.id)).find((s) => s.id === serverId);
    if (!server) throw new UserError("This organization cannot deploy to that server.");
    if (!server.isLocal && server.status !== "ready") throw new UserError(`${server.name} is not ready yet. Validate it first.`);
    await setDefaultServer(ctx.org.id, serverId);
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.update", message: `Made ${server.name} the default server` });
    return null;
  });
}

/** Serve's own containers on a server that is being removed. */
async function removeServeContainers(ctx: Awaited<ReturnType<typeof getServer>>) {
  const { companionContainer, relayContainer } = await import("@/server/proxy/host-relay");
  for (const name of [relayContainer(ctx), companionContainer(ctx), ctx.proxyContainer, "serve-log-drain"]) {
    await ctx.docker
      .getContainer(name)
      .remove({ force: true })
      .catch(() => {});
  }
}
