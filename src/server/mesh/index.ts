import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import type { ServerMesh } from "@/server/db/schema";
import { decrypt } from "@/server/crypto";
import { imageExists, LABEL } from "@/server/docker/client";
import { getServer, type ServerCtx, type ServerRow } from "@/server/servers/context";
import { composeServiceNames } from "@/server/deploy/compose";
import { newId } from "@/server/id";
import { envNetworkName } from "@/server/docker/networks";
import { meshMemberIds } from "./members";
import { AGENT_CONTAINER, AGENT_DOCKERFILE, AGENT_IMAGE, AGENT_SCRIPT, AGENT_VERSION, LINKS_JQ, RULES_JQ, WG_JQ } from "./agent";
import { addressChanges, type AgentConfig, agentConfig, allocateAddress, linked, type Need, neededAddresses, type PlanAddress, type PlanServer, type PlanService } from "./plan";

type Service = typeof schema.service.$inferSelect;
type Member = ServerRow & { mesh: ServerMesh; meshIndex: number; networks: string[] };

const isMember = (r: ServerRow): r is ServerRow & { mesh: ServerMesh; meshIndex: number } => !!r.mesh?.enabled && r.meshIndex !== null;

/** Servers that joined the private network (it may still be starting on some), with the private networks they are in. */
export async function meshMembers(): Promise<Member[]> {
  const [rows, links] = await Promise.all([db.select().from(schema.server).where(isNotNull(schema.server.meshIndex)), db.select().from(schema.privateNetworkMember)]);
  return rows.filter(isMember).map((r) => ({
    ...r,
    networks: links
      .filter((l) => l.serverId === r.id)
      .map((l) => l.networkId)
      .sort(),
  }));
}

const toPlanServer = (r: Member): PlanServer => ({
  id: r.id,
  index: r.meshIndex,
  endpoint: r.mesh.endpoint,
  port: r.mesh.port,
  publicKey: r.mesh.publicKey,
  networks: r.networks,
});

function toPlanService(s: Service): PlanService {
  let composeServices: string[] = [];
  if (s.type === "compose" && s.compose?.content) {
    try {
      composeServices = composeServiceNames(s.compose.content);
    } catch {
      composeServices = [];
    }
  }
  return {
    id: s.id,
    environmentId: s.environmentId,
    serverId: s.serverId,
    extraServerIds: s.type === "app" ? [...new Set((s.distribution?.extraServerIds ?? []).filter((id) => id && id !== s.serverId))] : [],
    type: s.type,
    slug: s.slug,
    hostname: s.hostname,
    composeServices,
    isolated: !!s.compose?.isolated,
    composeSubnet: s.compose?.subnet ?? null,
    currentDeploymentId: s.currentDeploymentId,
  };
}

async function loadPlan() {
  const members = await meshMembers();
  if (!members.length) return null;
  const [services, addresses] = await Promise.all([db.select().from(schema.service), db.select().from(schema.meshAddress)]);
  const plan = services.map(toPlanService);
  return { members, servers: members.map(toPlanServer), services: plan, addresses: addresses as (PlanAddress & { id: string })[] };
}

/** Follow moved services, forget what is gone and hand out the addresses the network now needs. */
async function reconcileAddresses(state: NonNullable<Awaited<ReturnType<typeof loadPlan>>>): Promise<{ needs: Need[]; addresses: PlanAddress[]; full: string[] }> {
  const { remove, move } = addressChanges(state.addresses, state.services);
  const idOf = (a: PlanAddress) => (a as PlanAddress & { id: string }).id;
  if (remove.length) await db.delete(schema.meshAddress).where(inArray(schema.meshAddress.id, remove.map(idOf)));
  for (const m of move)
    await db
      .update(schema.meshAddress)
      .set({ serverId: m.serverId })
      .where(eq(schema.meshAddress.id, idOf(m.address)));
  const removed = new Set(remove);
  const moved = new Map(move.map((m) => [m.address, m.serverId]));
  const addresses: PlanAddress[] = state.addresses.filter((a) => !removed.has(a)).map((a) => (moved.has(a) ? { ...a, serverId: moved.get(a)! } : a));

  const needs = neededAddresses(state.servers, state.services);
  const have = new Set(addresses.map((a) => `${a.serverId}|${a.key}`));
  const taken = new Set(addresses.map((a) => a.ip));
  const indexOf = new Map(state.servers.map((s) => [s.id, s.index]));
  const full: string[] = [];
  for (const n of needs) {
    if (have.has(`${n.serverId}|${n.key}`)) continue;
    const ip = allocateAddress(indexOf.get(n.serverId)!, n.key.startsWith("env:") ? "env" : "svc", taken);
    if (!ip) {
      full.push(n.serverId);
      continue;
    }
    const [row] = await db
      .insert(schema.meshAddress)
      .values({ id: newId(), serverId: n.serverId, key: n.key, serviceId: n.serviceId, environmentId: n.environmentId, ip })
      .onConflictDoNothing()
      .returning();
    const saved = row ?? (await db.select().from(schema.meshAddress).where(sql`${schema.meshAddress.serverId} = ${n.serverId} and ${schema.meshAddress.key} = ${n.key}`))[0];
    if (!saved) continue;
    addresses.push(saved);
    taken.add(saved.ip);
    have.add(`${n.serverId}|${n.key}`);
  }
  return { needs, addresses, full: [...new Set(full)] };
}

/* -------------------------------------------------------------------------- */
/*                                The agent                                   */
/* -------------------------------------------------------------------------- */

export const meshDir = (ctx: Pick<ServerCtx, "paths">) => path.posix.join(ctx.paths.root, "mesh");

async function buildAgentImage(ctx: ServerCtx) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "serve-mesh-"));
  try {
    await Promise.all([
      fs.writeFile(path.join(dir, "Dockerfile"), AGENT_DOCKERFILE),
      fs.writeFile(path.join(dir, "agent.sh"), AGENT_SCRIPT, { mode: 0o755 }),
      fs.writeFile(path.join(dir, "wg.jq"), WG_JQ),
      fs.writeFile(path.join(dir, "rules.jq"), RULES_JQ),
      fs.writeFile(path.join(dir, "links.jq"), LINKS_JQ),
    ]);
    const stream = await ctx.docker.buildImage(
      { context: dir, src: ["Dockerfile", "agent.sh", "wg.jq", "rules.jq", "links.jq"] },
      { t: AGENT_IMAGE, labels: { [LABEL.managed]: "true" } },
    );
    await new Promise<void>((resolve, reject) => {
      let failure: string | null = null;
      ctx.docker.modem.followProgress(
        stream,
        (error) => (error || failure ? reject(new Error(`Could not build the private network agent: ${failure ?? (error as Error).message}`)) : resolve()),
        (event: { error?: string; errorDetail?: { message?: string } }) => {
          if (event.error) failure = event.errorDetail?.message ?? event.error;
        },
      );
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  // Older agent images are no longer needed.
  const old = await ctx.docker.listImages({ filters: { reference: ["serve-mesh"] } }).catch(() => []);
  for (const img of old)
    for (const tag of img.RepoTags ?? [])
      if (tag !== AGENT_IMAGE)
        await ctx.docker
          .getImage(tag)
          .remove()
          .catch(() => {});
}

async function ensureAgent(ctx: ServerCtx) {
  if (!(await imageExists(AGENT_IMAGE, ctx.docker))) await buildAgentImage(ctx);
  const container = ctx.docker.getContainer(AGENT_CONTAINER);
  const info = await container.inspect().catch(() => null);
  if (info && info.Config.Image === AGENT_IMAGE && info.State.Running) return false;
  if (info) await container.remove({ force: true }).catch(() => {});
  const created = await ctx.docker.createContainer({
    name: AGENT_CONTAINER,
    Image: AGENT_IMAGE,
    Cmd: ["run"],
    Labels: { [LABEL.managed]: "true", [LABEL.kind]: "mesh" },
    Env: [`SERVE_MESH_IMAGE=${AGENT_IMAGE}`],
    HostConfig: {
      NetworkMode: "host",
      Privileged: true,
      Init: true,
      RestartPolicy: { Name: "always" },
      Binds: [`${meshDir(ctx)}:/etc/serve-mesh`, "/var/run/docker.sock:/var/run/docker.sock"],
      LogConfig: { Type: "json-file", Config: { "max-size": "5m", "max-file": "2" } },
    },
  });
  await created.start();
  return true;
}

/** Make the agent re-read its configuration and the containers now instead of within 3 seconds. */
async function kickAgent(ctx: ServerCtx) {
  await ctx.docker
    .getContainer(AGENT_CONTAINER)
    .kill({ signal: "SIGUSR1" })
    .catch(() => {});
}

async function pushConfig(ctx: ServerCtx, config: AgentConfig) {
  await ctx.fs.writeFile(path.posix.join(meshDir(ctx), "config.json"), `${JSON.stringify(config, null, 2)}\n`, 0o600);
  const started = await ensureAgent(ctx);
  if (!started) await kickAgent(ctx);
}

/** Remove the agent, the WireGuard interface and the firewall rules from a server. */
export async function teardownMesh(ctx: ServerCtx) {
  await ctx.docker
    .getContainer(AGENT_CONTAINER)
    .remove({ force: true })
    .catch(() => {});
  const images = await ctx.docker.listImages({ filters: { reference: ["serve-mesh"] } }).catch(() => []);
  const image = images.flatMap((i) => i.RepoTags ?? []).find((t) => t.startsWith("serve-mesh:"));
  if (image) {
    const once = await ctx.docker.createContainer({
      Image: image,
      Cmd: ["down"],
      Labels: { [LABEL.managed]: "true", [LABEL.kind]: "mesh" },
      HostConfig: { NetworkMode: "host", Privileged: true, AutoRemove: true, Binds: ["/var/run/docker.sock:/var/run/docker.sock"] },
    });
    await once.start();
    await once.wait().catch(() => {});
    for (const img of images)
      for (const tag of img.RepoTags ?? [])
        await ctx.docker
          .getImage(tag)
          .remove()
          .catch(() => {});
  }
  await ctx.fs.rm(meshDir(ctx)).catch(() => {});
}

async function setMesh(id: string, patch: Partial<ServerMesh>) {
  const [row] = await db.select({ mesh: schema.server.mesh }).from(schema.server).where(eq(schema.server.id, id));
  if (!row?.mesh) return;
  await db
    .update(schema.server)
    .set({ mesh: { ...row.mesh, ...patch } })
    .where(eq(schema.server.id, id));
}

/* -------------------------------------------------------------------------- */
/*                                    Sync                                    */
/* -------------------------------------------------------------------------- */

type Pending = { scope: Set<string> | null; kicks: Set<string>; promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void };
const store = globalThis as unknown as { __serveMesh?: { running: Promise<void> | null; pending: Pending | null } };
const state = (store.__serveMesh ??= { running: null, pending: null });

/**
 * Bring servers in line with the database: hand out addresses, write each agent's configuration
 * where it changed, and remove the network from servers that left it. Runs one at a time; calls
 * made while one runs share the next run. `servers` limits which servers are written to (a
 * deploy only needs its environment's servers, so an offline server elsewhere never slows it
 * down); `kick` asks those agents to pick up new containers right away.
 */
export function syncMesh(opts: { servers?: string[]; kick?: string[] } = {}): Promise<void> {
  let next = state.pending;
  if (!next) {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    next = { scope: new Set(), kicks: new Set(), promise, resolve, reject };
    state.pending = next;
    const start = () => {
      const run = state.pending!;
      state.pending = null;
      state.running = runSync(run.scope, run.kicks)
        .then(run.resolve, run.reject)
        .finally(() => {
          state.running = null;
        });
    };
    void (state.running ?? Promise.resolve()).then(start, start);
  }
  if (!opts.servers) next.scope = null;
  else if (next.scope) for (const id of opts.servers) next.scope.add(id);
  for (const id of opts.kick ?? []) {
    next.kicks.add(id);
    next.scope?.add(id);
  }
  return next.promise;
}

/** A server that does not answer within 10 seconds is skipped (and marked) instead of holding everything up. */
async function reachable(serverId: string): Promise<ServerCtx> {
  const ctx = await getServer(serverId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([ctx.docker.ping(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${ctx.name} did not answer.`)), 10_000)))]);
  } catch (error) {
    throw new Error(`Could not reach ${ctx.name}: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  return ctx;
}

/** When each server's agent was last checked. */
const checked = new Map<string, number>();

/** Resolves to null when the promise takes longer than `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

async function runSync(scope: Set<string> | null, kicks: Set<string>) {
  if (!scope) {
    // Servers that left the network: take it down there.
    const leaving = await db.select().from(schema.server).where(sql`${schema.server.mesh} is not null and not coalesce((${schema.server.mesh}->>'enabled')::boolean, false)`);
    for (const row of leaving.filter((r) => r.mesh && r.mesh.state !== "off")) {
      try {
        await teardownMesh(await reachable(row.id));
        await setMesh(row.id, { state: "off", message: null, configHash: null, agent: null, syncedAt: new Date().toISOString() });
      } catch (error) {
        await setMesh(row.id, { message: `Could not remove the private network: ${(error as Error).message}` });
      }
    }
  }

  const plan = await loadPlan();
  if (!plan) return;
  const { needs, addresses, full } = await reconcileAddresses(plan);

  await Promise.all(
    plan.members
      .filter((row) => !scope || scope.has(row.id))
      .map(async (row) => {
        const self = { ...toPlanServer(row), privateKey: decrypt(row.mesh.privateKey) };
        const config = agentConfig(self, plan.servers, plan.services, addresses, needs);
        const fullNote = full.length ? "No free private addresses are left; some services are not reachable from other servers." : null;
        let current = row.mesh.configHash === config.hash && row.mesh.agent === AGENT_VERSION && row.mesh.state === "ready";
        // Every few minutes, make sure the agent still runs (someone may have removed it).
        if (current && !scope && Date.now() - (checked.get(row.id) ?? 0) > 120_000) {
          checked.set(row.id, Date.now());
          const ctx = await getServer(row.id).catch(() => null);
          const info = ctx ? await withTimeout(ctx.docker.getContainer(AGENT_CONTAINER).inspect(), 10_000).catch(() => undefined) : undefined;
          // null: the server did not answer (checked again next time); undefined: the agent is gone.
          if (info === undefined || (info && (!info.State.Running || info.Config.Image !== AGENT_IMAGE))) current = false;
        }
        if (current && !kicks.has(row.id)) return;
        try {
          const ctx = await reachable(row.id);
          if (!current) {
            await pushConfig(ctx, config);
            await setMesh(row.id, { configHash: config.hash, agent: AGENT_VERSION, state: "ready", message: fullNote, syncedAt: new Date().toISOString() });
          } else await kickAgent(ctx);
        } catch (error) {
          await setMesh(row.id, { state: "error", message: (error as Error).message.slice(0, 500), configHash: null });
        }
      }),
  );
}

/* -------------------------------------------------------------------------- */
/*                                Deploy hooks                                */
/* -------------------------------------------------------------------------- */

/**
 * Before a service's containers start on a server: bring the network up to date for its
 * environment and wait until the names of its services on other servers resolve there.
 */
export async function meshBeforeStart(service: Pick<Service, "id" | "environmentId">, serverId: string, log: (line: string) => void) {
  try {
    const members = await meshMemberIds();
    if (!members.has(serverId)) return;
    // This server and the servers of the environment: they learn about each other's addresses.
    const siblings = await db
      .select({ serverId: schema.service.serverId, type: schema.service.type, distribution: schema.service.distribution })
      .from(schema.service)
      .where(eq(schema.service.environmentId, service.environmentId));
    const where = siblings.flatMap((s) => [s.serverId, ...(s.type === "app" ? (s.distribution?.extraServerIds ?? []) : [])]);
    await syncMesh({ servers: [...new Set([serverId, ...where])].filter((id) => members.has(id)), kick: [serverId] });
    const plan = await loadPlan();
    const self = plan?.servers.find((s) => s.id === serverId);
    if (!plan || !self) return;
    const needs = neededAddresses(plan.servers, plan.services);
    const wanted = agentConfig({ ...self, privateKey: "" }, plan.servers, plan.services, plan.addresses, needs).imports.filter(
      (i) => i.network === envNetworkName(service.environmentId),
    );
    if (!wanted.length) return;
    log(`Private network: ${wanted.flatMap((i) => i.aliases).join(", ")} on other servers`);
    const ctx = await getServer(serverId);
    const deadline = Date.now() + 20_000;
    let missing = wanted.map((w) => w.name);
    while (missing.length && Date.now() < deadline) {
      const running = await ctx.docker.listContainers({ filters: { label: ["serve.kind=mesh-link"] } }).catch(() => []);
      const names = new Set(running.map((c) => c.Names[0]?.replace(/^\//, "")));
      missing = missing.filter((n) => !names.has(n));
      if (missing.length) await new Promise((r) => setTimeout(r, 700));
    }
    if (missing.length) log("Warning: private network: names on other servers are not ready yet; they start working within a few seconds.");
  } catch (error) {
    log(`Warning: private network: ${(error as Error).message}`);
  }
}

/** After new containers run on a server: forward its private addresses to them right away. */
export async function meshAfterStart(serverId: string, log: (line: string) => void) {
  try {
    if (!(await meshMemberIds()).has(serverId)) return;
    await syncMesh({ servers: [serverId], kick: [serverId] });
  } catch (error) {
    log(`Warning: private network: ${(error as Error).message}`);
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Status                                   */
/* -------------------------------------------------------------------------- */

export type AgentStatus = {
  ok: boolean;
  error: string | null;
  mode: "kernel" | "userspace";
  firewall: string;
  hash: string;
  updatedAt: number;
  peers: { publicKey: string; endpoint: string | null; latestHandshake: number; rx: number; tx: number }[];
};

/** What the agent on a server last reported; null when it has not (yet). */
export async function readAgentStatus(ctx: ServerCtx): Promise<AgentStatus | null> {
  try {
    return JSON.parse(await ctx.fs.readFile(path.posix.join(meshDir(ctx), "status.json"))) as AgentStatus;
  } catch {
    return null;
  }
}

/** Addresses a server holds, with what they belong to (for the server page). */
export async function meshAddressesOf(serverId: string) {
  return db
    .select({
      ip: schema.meshAddress.ip,
      key: schema.meshAddress.key,
      serviceId: schema.meshAddress.serviceId,
      serviceName: schema.service.name,
      projectId: schema.service.projectId,
      environmentId: schema.meshAddress.environmentId,
      environmentName: schema.environment.name,
      projectName: schema.project.name,
    })
    .from(schema.meshAddress)
    .leftJoin(schema.service, eq(schema.meshAddress.serviceId, schema.service.id))
    .leftJoin(schema.environment, sql`${schema.environment.id} = coalesce(${schema.meshAddress.environmentId}, ${schema.service.environmentId})`)
    .leftJoin(schema.project, eq(schema.environment.projectId, schema.project.id))
    .where(eq(schema.meshAddress.serverId, serverId));
}

export { meshMemberIds, privatelyConnected } from "./members";

export type MeshPeerView = {
  serverId: string;
  name: string;
  address: string;
  endpoint: string | null;
  /** Seconds since the epoch; 0 = never. */
  latestHandshake: number;
  rx: number;
  tx: number;
  state: "starting" | "ready" | "error" | "off";
  message: string | null;
  /** It has no public address: it connects out and cannot be dialed. */
  nat: boolean;
};

export type MeshNetworkView = {
  id: string;
  name: string;
  /** This server is in it. */
  member: boolean;
  servers: { id: string; name: string; joined: boolean }[];
};

export type MeshOverview = {
  enabled: boolean;
  /** Every private network, with the servers in each. */
  networks: MeshNetworkView[];
  state: ServerMesh["state"] | null;
  message: string | null;
  endpoint: string | null;
  port: number | null;
  address: string | null;
  /** The agent's last report; null when the server could not be read or the agent has not reported. */
  agent: Omit<AgentStatus, "peers"> | null;
  /** Agent report older than 30 seconds: it stopped. */
  stale: boolean;
  peers: MeshPeerView[];
  /** Services on other servers that this server's environments use, by the names they answer to here. */
  reachable: { ip: string; names: string[]; serviceName: string; serverName: string; href: string | null }[];
  addresses: {
    ip: string;
    kind: "service" | "environment";
    name: string;
    projectName: string | null;
    environmentName: string | null;
    href: string | null;
    /** Handed out but not used right now (the environment runs on one server only). */
    idle: boolean;
  }[];
};

/** Every private network with its servers, by name. */
export async function meshNetworks(): Promise<Omit<MeshNetworkView, "member">[]> {
  const [networks, links] = await Promise.all([
    db.select().from(schema.privateNetwork),
    db
      .select({ networkId: schema.privateNetworkMember.networkId, id: schema.server.id, name: schema.server.name, mesh: schema.server.mesh, meshIndex: schema.server.meshIndex })
      .from(schema.privateNetworkMember)
      .innerJoin(schema.server, eq(schema.privateNetworkMember.serverId, schema.server.id)),
  ]);
  return networks
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((n) => ({
      id: n.id,
      name: n.name,
      servers: links
        .filter((l) => l.networkId === n.id)
        .map((l) => ({ id: l.id, name: l.name, joined: !!l.mesh?.enabled && l.meshIndex !== null }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

/** Everything the server page shows about the private network. */
export async function meshOverview(serverId: string, readStatus = true): Promise<MeshOverview> {
  const { meshServerAddress } = await import("@/lib/mesh");
  const [row] = await db.select().from(schema.server).where(eq(schema.server.id, serverId));
  const members = await meshMembers();
  const self = members.find((m) => m.id === serverId) ?? null;
  const networks = await meshNetworks();
  let agent: AgentStatus | null = null;
  if (self && readStatus) {
    const ctx = await getServer(serverId).catch(() => null);
    if (ctx) agent = await Promise.race([readAgentStatus(ctx), new Promise<null>((r) => setTimeout(() => r(null), 6000))]);
  }
  const plan = self ? await loadPlan() : null;
  const needs = plan ? neededAddresses(plan.servers, plan.services) : [];
  const needed = new Set(needs.map((n) => `${n.serverId}|${n.key}`));
  const rows = self ? await meshAddressesOf(serverId) : [];
  // Only servers sharing a private network with this one are its peers.
  const peers: MeshPeerView[] = members
    .filter((m) => self && linked(toPlanServer(self), toPlanServer(m)))
    .sort((a, b) => a.meshIndex - b.meshIndex)
    .map((m) => {
      const seen = agent?.peers.find((p) => p.publicKey === m.mesh.publicKey);
      return {
        serverId: m.id,
        name: m.name,
        address: meshServerAddress(m.meshIndex),
        endpoint: seen?.endpoint ?? (m.mesh.endpoint ? `${m.mesh.endpoint}:${m.mesh.port}` : null),
        latestHandshake: seen?.latestHandshake ?? 0,
        rx: seen?.rx ?? 0,
        tx: seen?.tx ?? 0,
        state: m.mesh.state,
        message: m.mesh.message ?? null,
        nat: !m.mesh.endpoint,
      };
    });
  const { peers: _p, ...agentRest } = agent ?? { peers: [] };
  const imports = self && plan ? agentConfig({ ...toPlanServer(self), privateKey: "" }, plan.servers, plan.services, plan.addresses, needs).imports : [];
  const importRows = imports.length
    ? await db
        .select({ ip: schema.meshAddress.ip, serviceId: schema.service.id, name: schema.service.name, projectId: schema.service.projectId, serverName: schema.server.name })
        .from(schema.meshAddress)
        .innerJoin(schema.service, eq(schema.meshAddress.serviceId, schema.service.id))
        .innerJoin(schema.server, eq(schema.meshAddress.serverId, schema.server.id))
        .where(
          inArray(
            schema.meshAddress.ip,
            imports.map((i) => i.ip),
          ),
        )
    : [];
  return {
    enabled: !!row?.mesh?.enabled,
    networks: networks.map((n) => ({ ...n, member: n.servers.some((s) => s.id === serverId) })),
    state: row?.mesh?.state ?? null,
    message: row?.mesh?.message ?? null,
    endpoint: row?.mesh?.endpoint ?? null,
    port: row?.mesh?.port ?? null,
    address: self ? meshServerAddress(self.meshIndex) : null,
    agent: agent ? (agentRest as Omit<AgentStatus, "peers">) : null,
    stale: !!agent && Date.now() / 1000 - agent.updatedAt > 30,
    peers,
    reachable: imports.map((i) => {
      const r = importRows.find((x) => x.ip === i.ip);
      return {
        ip: i.ip,
        names: i.aliases,
        serviceName: r?.name ?? i.aliases[0],
        serverName: r?.serverName ?? "",
        href: r ? `/projects/${r.projectId}/services/${r.serviceId}` : null,
      };
    }),
    addresses: rows
      .map((a) => ({
        ip: a.ip,
        kind: a.key.startsWith("env:") ? ("environment" as const) : ("service" as const),
        name: a.key.startsWith("env:") ? (a.environmentName ?? "Environment") : `${a.serviceName ?? "Service"}${a.key.split(":")[2] ? ` · ${a.key.split(":")[2]}` : ""}`,
        projectName: a.projectName,
        environmentName: a.environmentName,
        href: a.serviceId && a.projectId ? `/projects/${a.projectId}/services/${a.serviceId}` : null,
        idle: !needed.has(`${serverId}|${a.key}`),
      }))
      .sort((x, y) => x.ip.localeCompare(y.ip, undefined, { numeric: true })),
  };
}

export { generateMeshKeys } from "./keys";
export { meshAliases } from "./plan";
