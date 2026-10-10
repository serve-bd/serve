"use server";

import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { ForbiddenError, type OrgContext, requireOrg } from "@/server/auth";
import { canManageServer, ownerFor, requireServerAdmin, requireServerCreator, serverFitsNetwork } from "@/server/servers/access";
import { db, schema } from "@/server/db";
import { encrypt } from "@/server/crypto";
import { enqueue } from "@/server/queue";
import { logActivity } from "@/server/activity";
import { MESH_DEFAULT_PORT, MESH_MAX_SERVERS, meshEndpointProblem } from "@/lib/mesh";
import { generateMeshKeys } from "@/server/mesh/keys";
import { privatelyConnected } from "@/server/mesh/plan";
import type { MeshChange } from "@/server/mesh/impact";
import { newId } from "@/server/id";

const networkName = z.string().trim().min(1, "Enter a name.").max(40, "Use 40 characters or fewer.");

const meshInput = z.object({
  enabled: z.boolean(),
  endpoint: z.string().trim().max(253).optional(),
  /** No public address (home internet, shared IP): the server connects out and others never dial it. */
  nat: z.boolean().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  /** On joining: private networks to put the server in (ids), and/or a new one to create for it. */
  networks: z.array(z.string()).optional(),
  newNetwork: networkName.optional(),
});

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type Ctx = Pick<OrgContext, "isInstanceAdmin" | "isAdmin" | "org">;

/** Root admins manage every network; an organization's admins manage its own. */
const canManageNetwork = (ctx: Ctx, network: { organizationId: string | null }) =>
  ctx.isInstanceAdmin || (ctx.isAdmin && !!network.organizationId && network.organizationId === ctx.org.id);

async function requireNetworkAdmin(networkId: string) {
  const ctx = await requireOrg();
  const [network] = await db.select().from(schema.privateNetwork).where(eq(schema.privateNetwork.id, networkId));
  if (!network) throw new UserError("Private network not found.");
  if (!canManageNetwork(ctx, network)) throw new ForbiddenError("Only admins of the organization that owns this private network, or Root admins, can change it.");
  return { ctx, network };
}

/**
 * Whether a server may be in a network: an organization's networks hold its own servers and the
 * ones shared with it, the instance's networks only instance servers. Root admins may connect anything.
 */
function assertSameOwner(
  ctx: Ctx,
  network: { organizationId: string | null; name: string },
  server: { ownerOrganizationId: string | null; organizationIds: string[] | null; name: string },
) {
  if (ctx.isInstanceAdmin) return;
  if (!serverFitsNetwork(network, server)) throw new UserError(`${server.name} belongs to another organization, so it cannot join ${network.name}.`);
}

/**
 * Who puts a server in (or takes it out of) a network: its managers, and admins of the network's
 * organization for a server shared with it. Joining the private network itself stays with managers.
 */
const canPlace = (ctx: Ctx, network: { organizationId: string | null }, server: { ownerOrganizationId: string | null; organizationIds: string[] | null }) =>
  canManageServer(ctx, server) || (canManageNetwork(ctx, network) && serverFitsNetwork(network, server));

/** A new private network; the name must be free (any case). */
async function insertNetwork(tx: Tx, name: string, organizationId: string | null = null) {
  const [taken] = await tx
    .select({ id: schema.privateNetwork.id })
    .from(schema.privateNetwork)
    .where(sql`lower(${schema.privateNetwork.name}) = lower(${name}) and ${schema.privateNetwork.organizationId} is not distinct from ${organizationId}`);
  if (taken) throw new UserError(`A private network named "${name}" already exists.`);
  try {
    const [row] = await tx.insert(schema.privateNetwork).values({ id: newId(), name, organizationId }).returning();
    return row;
  } catch (error) {
    // Someone took the name at the same moment.
    if (uniqueViolation(error)) throw new UserError(`A private network named "${name}" already exists.`);
    throw error;
  }
}

const uniqueViolation = (error: unknown) => [(error as { code?: string }).code, (error as { cause?: { code?: string } }).cause?.code].includes("23505");

/** Join or leave the private network, or change the address other servers use. */
export async function saveMesh(serverId: string, input: z.input<typeof meshInput>) {
  return act(async () => {
    const { ctx } = await requireServerAdmin(serverId);
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
      if (!row.mesh?.enabled) {
        // Joining: into exactly the chosen networks (kept ones from before leaving included when still picked).
        const ids = [...new Set(data.networks ?? [])];
        if (data.newNetwork) ids.push((await insertNetwork(tx, data.newNetwork, row.ownerOrganizationId)).id);
        if (!ids.length) throw new UserError("Choose a private network for this server.");
        const networks = await tx.select().from(schema.privateNetwork).where(inArray(schema.privateNetwork.id, ids));
        if (ids.some((id) => !networks.some((n) => n.id === id))) throw new UserError("That private network no longer exists. Reload the page.");
        for (const n of networks) {
          if (!canManageNetwork(ctx, n)) throw new ForbiddenError(`You cannot add servers to ${n.name}.`);
          assertSameOwner(ctx, n, row);
        }
        await tx.delete(schema.privateNetworkMember).where(eq(schema.privateNetworkMember.serverId, serverId));
        await tx
          .insert(schema.privateNetworkMember)
          .values(ids.map((networkId) => ({ networkId, serverId })))
          .catch((error) => {
            throw [(error as { code?: string }).code, (error as { cause?: { code?: string } }).cause?.code].includes("23503")
              ? new UserError("That private network no longer exists. Reload the page.")
              : error;
          });
      }
      // null: behind NAT. A new address replaces it; otherwise the saved choice stays.
      const endpoint = data.nat ? null : data.endpoint !== undefined ? data.endpoint.trim() : row.mesh ? row.mesh.endpoint : "";
      const problem = endpoint === null ? null : meshEndpointProblem(endpoint);
      if (problem) throw new UserError(problem);
      const port = data.port ?? row.mesh?.port ?? MESH_DEFAULT_PORT;
      let index = row.meshIndex;
      if (index === null) {
        const used = new Set((await tx.select({ i: schema.server.meshIndex }).from(schema.server).where(isNotNull(schema.server.meshIndex))).map((r) => r.i));
        for (let i = 1; i <= MESH_MAX_SERVERS && index === null; i++) if (!used.has(i)) index = i;
        if (index === null) throw new UserError(`The private network holds up to ${MESH_MAX_SERVERS} servers.`);
      }
      const keys = row.mesh?.publicKey ? null : generateMeshKeys();
      const changed = !row.mesh?.enabled || row.mesh.endpoint !== endpoint || row.mesh.port !== port;
      await tx
        .update(schema.server)
        .set({
          meshIndex: index,
          mesh: {
            ...(row.mesh ?? {}),
            enabled: true,
            endpoint,
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

/**
 * Join the private network straight into one network (a line drawn to a server that has not joined
 * yet). Other servers reach it at its public IP, else its SSH address; without either it connects
 * out (behind NAT). The address can be changed later on the server's Private network page.
 */
export async function joinIntoNetwork(networkId: string, serverId: string) {
  return act(async () => {
    await requireServerAdmin(serverId);
    const [row] = await db.select().from(schema.server).where(eq(schema.server.id, serverId));
    if (!row) throw new UserError("Server not found.");
    const usable = (a: string | null | undefined) => (a && !meshEndpointProblem(a) ? a : null);
    const endpoint = usable(row.publicIp) ?? (!row.isLocal && !row.tunnel && !row.tailscale?.only ? usable(row.host) : null);
    // Joined meanwhile: only the network changes.
    const r =
      row.mesh?.enabled && row.meshIndex !== null
        ? await setNetworkMember(networkId, serverId, true)
        : await saveMesh(serverId, endpoint ? { enabled: true, endpoint, networks: [networkId] } : { enabled: true, nat: true, networks: [networkId] });
    if (!r.ok) throw new UserError(r.error);
    return { endpoint };
  });
}

/** Rewrite every server's configuration now (after fixing a firewall, for example). */
export async function resyncMesh(serverId: string) {
  return act(async () => {
    await requireServerAdmin(serverId);
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

/** Addresses a server can be reached at, to pick from instead of typing one. */
export async function meshAddressOptions(serverId: string) {
  return act(async () => {
    await requireServerAdmin(serverId);
    const [row] = await db.select().from(schema.server).where(eq(schema.server.id, serverId));
    if (!row) throw new UserError("Server not found.");
    const options: { address: string; label: string }[] = [];
    const add = (address: string | null | undefined, label: string) => {
      if (address && !meshEndpointProblem(address) && !options.some((o) => o.address === address)) options.push({ address, label });
    };
    // The address the internet sees; with a shared (CGNAT) connection nobody can dial it.
    add(row.publicIp, "seen from the internet");
    if (!row.isLocal) {
      // A server that connects out has no address of its own to offer.
      if (!row.tunnel && !row.tailscale?.only) add(row.host, "SSH address");
      // The server's own interfaces, without Docker's bridges, the private network itself and Tailscale (Serve uses that address on its own when both ends are in a tailnet).
      const { getServer } = await import("@/server/servers/context");
      const ctx = await getServer(serverId);
      const res = await ctx.exec("ip -4 -o addr show scope global", { timeoutMs: 10_000 }).catch(() => null);
      for (const line of res?.stdout.split("\n") ?? []) {
        const [, iface, , cidr] = line.trim().split(/\s+/);
        if (!iface || !cidr || /^(docker|br-|veth|serve-mesh|virbr|cni|flannel|kube|tailscale)/.test(iface)) continue;
        add(cidr.split("/")[0], iface);
      }
    }
    return options;
  });
}

/* ------------------------------- Networks -------------------------------- */

/** Create a private network, optionally with servers in it. */
export async function createNetwork(name: string, serverIds: string[] = []) {
  return act(async () => {
    const ctx = await requireServerCreator();
    const parsed = networkName.parse(name);
    const network = await db.transaction(async (tx) => {
      const row = await insertNetwork(tx, parsed, ownerFor(ctx));
      const ids = [...new Set(serverIds)];
      if (ids.length) {
        const found = await tx.select().from(schema.server).where(inArray(schema.server.id, ids));
        if (found.length !== ids.length) throw new UserError("A server no longer exists. Reload the page.");
        for (const s of found) {
          if (!canPlace(ctx, row, s)) throw new ForbiddenError(`You cannot add ${s.name} to a network.`);
          assertSameOwner(ctx, row, s);
        }
        await tx.insert(schema.privateNetworkMember).values(ids.map((serverId) => ({ networkId: row.id, serverId })));
      }
      return row;
    });
    if (serverIds.length) await enqueue("mesh.sync", {}, { concurrencyKey: "mesh" });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.update", message: `Created the private network ${network.name}` });
    return { id: network.id };
  });
}

export async function renameNetwork(networkId: string, name: string) {
  return act(async () => {
    const { ctx } = await requireNetworkAdmin(networkId);
    const parsed = networkName.parse(name);
    const old = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(schema.privateNetwork).where(eq(schema.privateNetwork.id, networkId));
      if (!row) throw new UserError("Private network not found.");
      const [taken] = await tx
        .select({ id: schema.privateNetwork.id })
        .from(schema.privateNetwork)
        .where(
          sql`lower(${schema.privateNetwork.name}) = lower(${parsed}) and ${schema.privateNetwork.organizationId} is not distinct from ${row.organizationId} and ${schema.privateNetwork.id} <> ${networkId}`,
        );
      if (taken) throw new UserError(`A private network named "${parsed}" already exists.`);
      await tx
        .update(schema.privateNetwork)
        .set({ name: parsed })
        .where(eq(schema.privateNetwork.id, networkId))
        .catch((error) => {
          throw uniqueViolation(error) ? new UserError(`A private network named "${parsed}" already exists.`) : error;
        });
      return row;
    });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.update", message: `Renamed the private network ${old.name} to ${parsed}` });
    return null;
  });
}

/** Delete a private network: its servers stop reaching each other unless they share another one. */
export async function deleteNetwork(networkId: string) {
  return act(async () => {
    const { ctx } = await requireNetworkAdmin(networkId);
    // The same lock as joining, so a server never joins a network while it is being deleted.
    const [row] = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('serve-mesh'))`);
      return tx.delete(schema.privateNetwork).where(eq(schema.privateNetwork.id, networkId)).returning();
    });
    if (!row) throw new UserError("Private network not found.");
    await enqueue("mesh.sync", {}, { concurrencyKey: "mesh" });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.update", message: `Deleted the private network ${row.name}` });
    return null;
  });
}

/** Put a server in a private network or take it out. */
export async function setNetworkMember(networkId: string, serverId: string, member: boolean) {
  return act(async () => {
    const { ctx, network } = await requireNetworkAdmin(networkId);
    const [server] = await db.select().from(schema.server).where(eq(schema.server.id, serverId));
    if (!server) throw new UserError("Server not found.");
    // Taking a server out of the organization's own network is always allowed to its admins.
    if (member ? !canPlace(ctx, network, server) : !canManageServer(ctx, server) && !canManageNetwork(ctx, network)) {
      throw new ForbiddenError(`You cannot change where ${server.name} is.`);
    }
    if (member) assertSameOwner(ctx, network, server);
    if (member)
      await db
        .insert(schema.privateNetworkMember)
        .values({ networkId, serverId })
        .onConflictDoNothing()
        .catch((error) => {
          // The network or the server was deleted a moment ago.
          throw [(error as { code?: string }).code, (error as { cause?: { code?: string } }).cause?.code].includes("23503")
            ? new UserError("That network or server no longer exists. Reload the page.")
            : error;
        });
    else await db.delete(schema.privateNetworkMember).where(and(eq(schema.privateNetworkMember.networkId, networkId), eq(schema.privateNetworkMember.serverId, serverId)));
    await enqueue("mesh.sync", {}, { concurrencyKey: "mesh" });
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "server.update",
      message: member ? `Added ${server.name} to the private network ${network.name}` : `Removed ${server.name} from the private network ${network.name}`,
    });
    return null;
  });
}

export type MeshImpact = {
  consumer: string;
  consumerServer: string;
  provider: string;
  providerServer: string;
  project: string;
  /** Link to the service's variables; null for another organization's service (not openable from here). */
  href: string | null;
  variables: string[];
}[];

/** What stops working if a server leaves a network, a network is deleted, or a server leaves the private network. */
export async function meshChangeImpact(change: MeshChange) {
  return act(async (): Promise<MeshImpact> => {
    const ctx = "networkId" in change ? (await requireNetworkAdmin(change.networkId)).ctx : (await requireServerAdmin(change.serverId)).ctx;
    const { meshMemberIds } = await import("@/server/mesh/members");
    const { lostLinks, membersAfter } = await import("@/server/mesh/impact");
    const { decryptOrNull } = await import("@/server/crypto");
    const before = await meshMemberIds();
    const after = membersAfter(before, change);
    // Only services on servers that lose a link can be affected.
    const losing = new Set<string>();
    const ids = [...before.keys()];
    for (const a of ids) for (const b of ids) if (a < b && privatelyConnected(before, a, b) && !privatelyConnected(after, a, b)) losing.add(a).add(b);
    if (!losing.size) return [];
    const { runServerIds } = await import("@/server/deploy/distribution");
    const { scopeReader } = await import("@/lib/refs");
    const rows = await db
      .select({
        id: schema.service.id,
        name: schema.service.name,
        slug: schema.service.slug,
        type: schema.service.type,
        serverId: schema.service.serverId,
        distribution: schema.service.distribution,
        environmentId: schema.service.environmentId,
        projectId: schema.service.projectId,
      })
      .from(schema.service);
    const services = rows.map((s) => ({ ...s, servers: runServerIds(s.serverId, s.type === "app" ? s.distribution : null) }));
    const envs = new Set(services.filter((s) => s.servers.some((id) => losing.has(id))).map((s) => s.environmentId));
    const relevant = services.filter((s) => envs.has(s.environmentId));
    if (!relevant.length) return [];
    const projectIds = [...new Set(relevant.map((s) => s.projectId))];
    const [vars, projectRows] = await Promise.all([
      db
        .select({ serviceId: schema.envVar.serviceId, key: schema.envVar.key, value: schema.envVar.value })
        .from(schema.envVar)
        .where(
          and(
            inArray(
              schema.envVar.serviceId,
              relevant.map((s) => s.id),
            ),
            // Literal values reference nothing: their ${{…}} is text.
            eq(schema.envVar.literal, false),
          ),
        )
        .then((list) => list.map((v) => ({ ...v, value: decryptOrNull(v.value) ?? "" }))),
      db.select({ id: schema.project.id, organizationId: schema.project.organizationId }).from(schema.project).where(inArray(schema.project.id, projectIds)),
    ]);
    // Shared variables, for references that go through them (like variable resolution does).
    const orgOf = new Map(projectRows.map((p) => [p.id, p.organizationId]));
    const sharedRows = await db
      .select()
      .from(schema.sharedVar)
      .where(
        or(
          inArray(schema.sharedVar.environmentId, [...envs]),
          inArray(schema.sharedVar.projectId, projectIds),
          inArray(schema.sharedVar.organizationId, [...new Set(orgOf.values())]),
        ),
      );
    const mapOf = (pick: (v: (typeof sharedRows)[number]) => boolean) => Object.fromEntries(sharedRows.filter(pick).map((v) => [v.key, decryptOrNull(v.value) ?? ""]));
    const scope = (c: { environmentId: string; projectId: string }) =>
      scopeReader({
        environment: mapOf((v) => v.environmentId === c.environmentId),
        project: mapOf((v) => !v.environmentId && v.projectId === c.projectId),
        org: mapOf((v) => !v.environmentId && !v.projectId && v.organizationId === orgOf.get(c.projectId)),
      });
    const links = lostLinks(before, after, relevant, vars, scope);
    if (!links.length) return [];
    const [servers, projects] = await Promise.all([
      db.select({ id: schema.server.id, name: schema.server.name }).from(schema.server),
      db.select({ id: schema.project.id, name: schema.project.name, organizationId: schema.project.organizationId }).from(schema.project),
    ]);
    const serverName = new Map(servers.map((s) => [s.id, s.name]));
    const projectName = new Map(projects.map((p) => [p.id, p.name]));
    // Servers are shared by organizations: other organizations' services are named, not linked.
    const ownProject = new Set(projects.filter((p) => p.organizationId === ctx.org.id).map((p) => p.id));
    const byId = new Map(relevant.map((s) => [s.id, s]));
    return links
      .map((l) => {
        const c = byId.get(l.consumerId)!;
        const p = byId.get(l.providerId)!;
        // Organization admins learn that another organization's service is affected, not its names.
        const hidden = !ctx.isInstanceAdmin && !ownProject.has(c.projectId);
        return {
          consumer: hidden ? "A service of another organization" : c.name,
          consumerServer: hidden ? "" : (serverName.get(c.serverId) ?? ""),
          provider: hidden && !ownProject.has(p.projectId) ? "another service" : p.name,
          providerServer: hidden ? "" : (serverName.get(p.serverId) ?? ""),
          project: hidden ? "Another organization" : (projectName.get(c.projectId) ?? ""),
          href: ownProject.has(c.projectId) ? `/projects/${c.projectId}/services/${c.id}/variables` : null,
          variables: hidden ? [] : l.variables.sort(),
        };
      })
      .sort((a, b) => a.project.localeCompare(b.project) || a.consumer.localeCompare(b.consumer));
  });
}

const canvasPositions = z.record(z.string().max(32), z.object({ x: z.number().finite().min(-1e5).max(1e5), y: z.number().finite().min(-1e5).max(1e5) }));

/** Remember where servers and networks sit on the private networks canvas (merged: only moved ones are sent). */
export async function saveNetworkCanvas(positions: Record<string, { x: number; y: number }>) {
  return act(async () => {
    const ctx = await requireOrg();
    if (!ctx.isInstanceAdmin && !ctx.isAdmin) throw new ForbiddenError("Only admins can arrange private networks.");
    // Organization admins place only their own servers and networks.
    const mine = ctx.isInstanceAdmin ? null : await managedIds(ctx);
    const moved = Object.fromEntries(
      Object.entries(canvasPositions.parse(positions))
        .filter(([id]) => !mine || mine.has(id))
        .map(([id, p]) => [id, { x: Math.round(p.x), y: Math.round(p.y) }]),
    );
    if (!Object.keys(moved).length) return null;
    // One statement, so two admins moving different cards never undo each other.
    await db.execute(sql`
      insert into setting (key, value) values ('networkCanvas', ${JSON.stringify(moved)}::jsonb)
      on conflict (key) do update set value = setting.value || excluded.value, updated_at = now()`);
    return null;
  });
}

/** Forget the private networks canvas layout. */
export async function resetNetworkCanvas() {
  return act(async () => {
    const ctx = await requireOrg();
    if (!ctx.isInstanceAdmin) throw new ForbiddenError("Only admins of the Root organization can reset the layout.");
    await db.delete(schema.setting).where(eq(schema.setting.key, "networkCanvas"));
    return null;
  });
}

/** Ids of the servers and networks an organization admin manages (canvas cards). */
async function managedIds(ctx: Ctx) {
  const [servers, networks] = await Promise.all([
    db.select({ id: schema.server.id, ownerOrganizationId: schema.server.ownerOrganizationId }).from(schema.server),
    db.select({ id: schema.privateNetwork.id, organizationId: schema.privateNetwork.organizationId }).from(schema.privateNetwork),
  ]);
  return new Set([...servers.filter((s) => canManageServer(ctx, s)).map((s) => s.id), ...networks.filter((n) => canManageNetwork(ctx, n)).map((n) => n.id)]);
}
