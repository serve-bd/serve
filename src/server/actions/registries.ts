"use server";

import { eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { type OrgContext, requirePermission } from "@/server/auth";
import { hostIsPrivate } from "@/server/net/public-host";
import { db, schema } from "@/server/db";
import { encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { enqueue } from "@/server/queue";
import { logActivity } from "@/server/activity";
import type { RegistryKind } from "@/server/db/schema";
import { checkRegistryLogin, getRegistry, registryAuth } from "@/server/registries";
import { authServer, normalizeHost, normalizeRepository, registryPresets, renderTag } from "@/server/registries/refs";
import { balances, distributionProblem, normalizeDistribution, runServerIds } from "@/server/deploy/distribution";
import { balanceProblem } from "@/server/services/balance";
import { pullsFromRegistry, usesRegistry } from "@/server/services/distribution-query";
import { listImages, listTags } from "@/server/registries/browse";
import { serviceInOrg } from "@/server/services/access";
import { resolveServerForOrg } from "@/server/servers/access";
import { queueDeployment } from "@/server/services/create";
import { requireResourceChange, requireServers, runCopies } from "@/server/limits";
import { extraCleanupKey } from "@/server/services/lifecycle";

/* -------------------------------------------------------------------------- */
/*                                 Registries                                 */
/* -------------------------------------------------------------------------- */

const kinds = Object.keys(registryPresets) as [RegistryKind, ...RegistryKind[]];

const registrySchema = z.object({
  kind: z.enum(kinds),
  name: z.string().trim().min(1).max(60),
  host: z.string().trim().default(""),
  username: z.string().trim().min(1, "Enter the registry username.").max(200),
  password: z.string().default(""),
  namespace: z.string().trim().max(200).default(""),
});

function parseRegistry(input: z.input<typeof registrySchema>) {
  const data = registrySchema.parse(input);
  const host = normalizeHost(data.host || registryPresets[data.kind].host);
  if (!host) throw new UserError("Enter the registry host.");
  const namespace = data.namespace.replace(/^\/+|\/+$/g, "").toLowerCase() || null;
  return { ...data, host, namespace };
}

/** A registry on a private address is for the Root organization only: Docker on the server would log in to it. */
async function assertRegistryHost(ctx: OrgContext, host: string) {
  if (!ctx.isRoot && (await hostIsPrivate(host))) throw new UserError("That registry is on a private network or does not resolve.");
}

async function assertLogin(host: string, username: string, password: string) {
  try {
    await checkRegistryLogin({ username, password, serveraddress: authServer(host) });
  } catch (error) {
    throw new UserError((error as Error).message);
  }
}

export async function addRegistry(input: z.input<typeof registrySchema>) {
  return act(async () => {
    const ctx = await requirePermission("integrations.manage");
    const data = parseRegistry(input);
    if (!data.password) throw new UserError("Enter a password or access token.");
    await assertRegistryHost(ctx, data.host);
    await assertLogin(data.host, data.username, data.password);
    const id = newId();
    await db.insert(schema.containerRegistry).values({ id, organizationId: ctx.org.id, ...data, password: encrypt(data.password) });
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "registry.added",
      message: `Added the registry ${data.name} (${data.host})`,
      targetType: "registry",
      targetId: id,
    });
    return { id };
  });
}

/** Edit a registry. An empty password keeps the stored one; the login is checked again. */
export async function updateRegistry(id: string, input: z.input<typeof registrySchema>) {
  return act(async () => {
    const ctx = await requirePermission("integrations.manage");
    const row = await getRegistry(id, ctx.org.id);
    if (!row) throw new UserError("Registry not found.");
    const data = parseRegistry(input);
    // The login check sends the password to the host: a stored one only goes to the host it was saved for.
    if (!data.password && data.host !== row.host) throw new UserError("Enter the password again: the host changed.");
    const password = data.password || registryAuth(row).password;
    await assertRegistryHost(ctx, data.host);
    await assertLogin(data.host, data.username, password);
    await db
      .update(schema.containerRegistry)
      .set({ ...data, password: encrypt(password) })
      .where(eq(schema.containerRegistry.id, id));
    return null;
  });
}

export async function deleteRegistry(id: string) {
  return act(async () => {
    const ctx = await requirePermission("integrations.manage");
    const row = await getRegistry(id, ctx.org.id);
    if (!row) throw new UserError("Registry not found.");
    const users = await db
      .select({ name: schema.service.name })
      .from(schema.service)
      .where(or(usesRegistry(id), pullsFromRegistry(id)));
    if (users.length) {
      throw new UserError(`${users.map((u) => u.name).join(", ")} ${users.length === 1 ? "uses" : "use"} this registry. Choose another one in their settings first.`);
    }
    await db.delete(schema.containerRegistry).where(eq(schema.containerRegistry.id, id));
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "registry.removed",
      message: `Removed the registry ${row.name}`,
      targetType: "registry",
      targetId: id,
    });
    return null;
  });
}

export async function testRegistry(id: string) {
  return act(async () => {
    const ctx = await requirePermission("integrations.manage");
    const row = await getRegistry(id, ctx.org.id);
    if (!row) throw new UserError("Registry not found.");
    const auth = registryAuth(row);
    await assertLogin(row.host, auth.username, auth.password);
    return null;
  });
}

/* -------------------------------------------------------------------------- */
/*                       Build once, run on many servers                      */
/* -------------------------------------------------------------------------- */

const distributionSchema = z.object({
  buildServerId: z.string().nullable().default(null),
  registryId: z.string().nullable().default(null),
  repository: z.string().trim().max(255).nullable().default(null),
  tag: z.string().trim().max(128).nullable().default(null),
  tagLatest: z.boolean().default(false),
  extraServerIds: z.array(z.string()).default([]),
  /** Left out (an API call or form that does not know it): keeps the current choice. */
  loadBalance: z.boolean().nullable().optional(),
});

/**
 * Save where an app builds and runs. Servers taken off the list lose the
 * service's containers and site right away (their volumes stay).
 */
export async function saveDistribution(serviceId: string, input: z.input<typeof distributionSchema>, opts: { deploy?: boolean } = {}) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type !== "app") throw new UserError("Only apps can run on several servers.");
    if (service.parentServiceId) throw new UserError("Preview deployments run on their parent's server only.");
    const raw = distributionSchema.parse(input);
    const dist = normalizeDistribution(service.serverId, { ...raw, loadBalance: raw.loadBalance === undefined ? service.distribution?.loadBalance : raw.loadBalance });

    const picked = [dist.buildServerId, ...dist.extraServerIds].filter((x): x is string => !!x);
    for (const id of picked) await resolveServerForOrg(id, ctx.org.id);
    // Servers it already builds or runs on stay allowed, so an unchanged list still saves after a limit is lowered.
    const current = [...runServerIds(service.serverId, service.distribution), service.distribution?.buildServerId];
    const newServers = picked.filter((id) => !current.includes(id));
    await requireServers(ctx.org.id, newServers);
    // Each extra server runs every replica again: that counts against the CPU and memory limits.
    const copies = { before: runCopies(service.type, service.runtime, service.distribution), after: runCopies(service.type, service.runtime, dist) };
    if (copies.after > copies.before) await requireResourceChange(ctx.org.id, service.runtime, {}, copies);
    if (dist.registryId) {
      const registry = await getRegistry(dist.registryId, ctx.org.id);
      if (!registry) throw new UserError("Registry not found.");
      if (dist.repository) {
        try {
          dist.repository = normalizeRepository(dist.repository);
        } catch (error) {
          throw new UserError((error as Error).message);
        }
      }
    } else {
      dist.repository = null;
    }
    if (dist.tag) renderTag(dist.tag, { commit: "0000000000000", deployment: "abcdefgh", branch: "main", service: service.slug });
    const problem = distributionProblem(dist, service.source?.type);
    if (problem) throw new UserError(problem);
    // Closest server already spreads the visitors: each server serves its own, the main server none of the others'.
    const [shared] = await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.serviceId, serviceId));
    if (shared && balances(service.serverId, dist))
      throw new UserError("Closest server is on: Cloudflare already sends each visitor to the nearest server. Turn it off to load balance instead.");
    // Load balancing reaches other servers only through a private network: refused without one.
    if (balances(service.serverId, dist)) {
      // Only servers added now: one that left the network later keeps running (Domains warns about it).
      const already = normalizeDistribution(service.serverId, service.distribution).extraServerIds;
      const apart = await balanceProblem(
        service.serverId,
        dist.extraServerIds.filter((id) => !already.includes(id) || !service.distribution?.loadBalance),
      );
      if (apart) throw new UserError(apart);
    }

    const before = runServerIds(service.serverId, service.distribution).slice(1);
    const removed = before.filter((id) => !dist.extraServerIds.includes(id));
    // Health of copies on servers the app leaves is forgotten (a server added again starts fresh).
    const balance =
      service.balance && dist.loadBalance
        ? { copies: Object.fromEntries(Object.entries(service.balance.copies ?? {}).filter(([id]) => dist.extraServerIds.includes(id.split(":")[0]))) }
        : null;
    await db.update(schema.service).set({ distribution: dist, balance }).where(eq(schema.service.id, serviceId));

    // The own server's proxy stops sending traffic to removed copies before they are deleted, and the
    // private network hands out (or forgets) the copies' addresses for the load balancing.
    const { syncServiceProxy } = await import("@/server/proxy/nginx");
    await syncServiceProxy(serviceId, service.serverId).catch(() => {});
    const { syncMesh } = await import("@/server/mesh");
    void syncMesh().catch(() => {});
    // The shared tunnel leaves the servers taken off now; added ones get a connector once the app runs there.
    if (shared) {
      const { ensureConnectors } = await import("@/server/cloudflare/tunnels");
      void ensureConnectors(shared).catch(() => {});
    }

    for (const serverId of removed) {
      // The cleanup there (its proxy site first, then the containers) runs in the background, in its
      // own queue: a server that went away must not hold up this save or the app's next deploy.
      await enqueue(
        "service.delete",
        { serviceId, slug: service.slug, type: service.type, removeVolumes: false, environmentId: service.environmentId, serverId, keepFiles: true, extraCleanup: true },
        { concurrencyKey: extraCleanupKey(serviceId, serverId) },
      );
    }
    const names = async (ids: string[]) =>
      ids.length ? (await db.select({ name: schema.server.name }).from(schema.server).where(inArray(schema.server.id, ids))).map((s) => s.name) : [];
    const added = await names(dist.extraServerIds.filter((id) => !before.includes(id)));
    const gone = await names(removed);
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "service.distribution",
      targetType: "service",
      targetId: serviceId,
      message: [
        `Updated where ${service.name} builds and runs`,
        added.length ? `added ${added.join(", ")}` : null,
        gone.length ? `removed ${gone.join(", ")}` : null,
        !!dist.loadBalance !== !!service.distribution?.loadBalance ? `load balancing ${dist.loadBalance ? "on" : "off"}` : null,
      ]
        .filter(Boolean)
        .join("; "),
    });
    const deploymentId = opts.deploy ? await queueDeployment(serviceId, "redeploy", { userId: ctx.user.id }) : null;
    return { deploymentId, added, removed: gone };
  });
}

/* -------------------------------------------------------------------------- */
/*                                Image picker                                */
/* -------------------------------------------------------------------------- */

/** The images of a saved registry, for the Docker image form. */
export async function browseRegistryImages(registryId: string) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const row = await getRegistry(registryId, ctx.org.id);
    if (!row) throw new UserError("Registry not found.");
    try {
      return await listImages(row, ctx.isRoot);
    } catch (error) {
      throw new UserError(`Could not list the images of ${row.name}: ${(error as Error).message}`);
    }
  });
}

/** The tags of an image, newest first: from a saved registry, or a public one. */
export async function browseImageTags(input: { registryId?: string | null; image: string }) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const image = z.string().trim().min(1).max(300).parse(input.image);
    const row = input.registryId ? await getRegistry(input.registryId, ctx.org.id) : null;
    if (input.registryId && !row) throw new UserError("Registry not found.");
    try {
      return { tags: await listTags(row, image, ctx.isRoot) };
    } catch (error) {
      throw new UserError(`Could not list the tags: ${(error as Error).message}`);
    }
  });
}
