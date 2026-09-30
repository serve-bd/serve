import { createHash } from "node:crypto";
import { MESH_MTU, MESH_ROUTES, meshEndpoint, meshServerAddress, meshServerRange } from "@/lib/mesh";
import { networkAliases } from "@/lib/hostname";
import { composeAlias } from "@/server/proxy/names";

const envNetworkName = (environmentId: string) => `serve-env-${environmentId}`;

/** Pure planning for the private network: which addresses exist and what each server's agent does. */

export type PlanServer = {
  id: string;
  index: number;
  endpoint: string | null;
  port: number;
  publicKey: string;
  /** Private networks the server is in: it only talks to servers sharing one. */
  networks: string[];
};

/** Two servers reach each other's private names: the same server, or both joined and sharing a private network. */
export function privatelyConnected(members: Map<string, string[]>, a: string, b: string) {
  if (a === b) return true;
  const na = members.get(a);
  const nb = members.get(b);
  return !!na && !!nb && na.some((n) => nb.includes(n));
}

/** Two servers of the mesh that share a private network. */
export function linked(a: Pick<PlanServer, "id" | "networks">, b: Pick<PlanServer, "id" | "networks">) {
  return a.id !== b.id && a.networks.some((n) => b.networks.includes(n));
}

export type PlanService = {
  id: string;
  environmentId: string;
  /** The service's own server; the only one that exposes it. */
  serverId: string;
  /** Other servers its containers also run on (apps with extra servers). */
  extraServerIds: string[];
  type: "app" | "database" | "compose";
  slug: string;
  hostname: string | null;
  /** Compose services of a stack (each gets its own address). */
  composeServices: string[];
  /** Isolated stacks are not on the environment network, so they are not exposed either. */
  isolated: boolean;
  composeSubnet: string | null;
  currentDeploymentId: string | null;
};

/** For services, `serverId` is the server that currently exposes the address. */
export type PlanAddress = { serverId: string; key: string; ip: string };

export type Need = { serverId: string; key: string; serviceId: string | null; environmentId: string | null };

export type AgentConfig = {
  hash: string;
  privateKey: string;
  listenPort: number;
  address: string;
  mtu: number;
  routes: string[];
  peers: { serverId: string; publicKey: string; endpoint: string | null; allowedIps: string[] }[];
  localAddresses: string[];
  exposures: { ip: string; service: string; compose: string | null; deployment: string | null; network: string | null; allow: string[] }[];
  sources: { ip: string; networks: string[]; subnets: string[] }[];
  /** Services on other servers this server's environments use: a link container answers to their names. */
  imports: { name: string; ip: string; network: string; aliases: string[] }[];
};

export const serviceKey = (serviceId: string, compose?: string | null) => (compose ? `svc:${serviceId}:${compose}` : `svc:${serviceId}`);
export const environmentKey = (environmentId: string) => `env:${environmentId}`;

/** Address keys of a service: one, or one per compose service. Isolated stacks have none. */
export function serviceKeys(s: PlanService): { key: string; compose: string | null }[] {
  if (s.type !== "compose") return [{ key: serviceKey(s.id), compose: null }];
  if (s.isolated) return [];
  return s.composeServices.map((c) => ({ key: serviceKey(s.id, c), compose: c }));
}

/** Servers a service's containers run on. */
const placements = (s: PlanService) => [s.serverId, ...s.extraServerIds];

/**
 * Addresses the network needs right now. An environment takes part on each of its servers that
 * shares a private network with another of its servers: those get a source address for the
 * environment, and the services on them get an address each.
 */
export function neededAddresses(servers: PlanServer[], services: PlanService[]): Need[] {
  const byServer = new Map(servers.map((s) => [s.id, s]));
  const byEnv = new Map<string, PlanService[]>();
  for (const s of services) byEnv.set(s.environmentId, [...(byEnv.get(s.environmentId) ?? []), s]);
  const needs: Need[] = [];
  for (const [environmentId, list] of byEnv) {
    const where = [...new Set(list.flatMap(placements))].map((id) => byServer.get(id)).filter((s) => !!s);
    const taking = new Set(where.filter((a) => where.some((b) => linked(a, b))).map((s) => s.id));
    if (!taking.size) continue;
    for (const serverId of [...taking].sort()) needs.push({ serverId, key: environmentKey(environmentId), serviceId: null, environmentId });
    for (const s of list) {
      if (!taking.has(s.serverId)) continue;
      for (const { key } of serviceKeys(s)) needs.push({ serverId: s.serverId, key, serviceId: s.id, environmentId: null });
    }
  }
  return needs;
}

/**
 * Addresses to forget (stack services that are gone, deleted services) and service addresses
 * that follow their service to another server. Everything else is kept, so a service keeps its
 * address for good and names on other servers never go stale.
 */
export function addressChanges(addresses: PlanAddress[], services: PlanService[]): { remove: PlanAddress[]; move: { address: PlanAddress; serverId: string }[] } {
  const byId = new Map(services.map((s) => [s.id, s]));
  const remove: PlanAddress[] = [];
  const move: { address: PlanAddress; serverId: string }[] = [];
  for (const a of addresses) {
    if (!a.key.startsWith("svc:")) continue;
    const [, id, compose] = a.key.split(":");
    const s = byId.get(id);
    if (!s || (s.type === "compose" ? !compose || !s.composeServices.includes(compose) : !!compose)) remove.push(a);
    else if (s.serverId !== a.serverId) move.push({ address: a, serverId: s.serverId });
  }
  return { remove, move };
}

/**
 * The first free address: services from one pool (10.240.1.1-10.240.255.254) that does not
 * depend on the server, environments from their server's slot (10.241.N.2-254).
 */
export function allocateAddress(index: number, kind: "svc" | "env", taken: Set<string>): string | null {
  if (kind === "env") {
    for (let host = 2; host <= 254; host++) if (!taken.has(`10.241.${index}.${host}`)) return `10.241.${index}.${host}`;
    return null;
  }
  for (let a = 1; a <= 255; a++) for (let b = 1; b <= 254; b++) if (!taken.has(`10.240.${a}.${b}`)) return `10.240.${a}.${b}`;
  return null;
}

/** What one server's agent does: its WireGuard peers (servers sharing a private network), the addresses it holds, forwarding and source rules. */
export function agentConfig(self: PlanServer & { privateKey: string }, servers: PlanServer[], services: PlanService[], addresses: PlanAddress[], needs: Need[]): AgentConfig {
  const needed = new Set(needs.map((n) => `${n.serverId}|${n.key}`));
  const live = addresses.filter((a) => needed.has(`${a.serverId}|${a.key}`));
  const byId = new Map(services.map((s) => [s.id, s]));
  // Servers sharing a private network with this one: its peers, and the only ones it serves or uses.
  const peers = servers.filter((s) => linked(self, s));
  const near = new Set(peers.map((s) => s.id));

  const exposures: AgentConfig["exposures"] = [];
  const sources: AgentConfig["sources"] = [];
  for (const a of live.filter((x) => x.serverId === self.id).sort((x, y) => x.key.localeCompare(y.key))) {
    if (a.key.startsWith("env:")) {
      const environmentId = a.key.slice(4);
      const subnets = services
        .filter((s) => s.environmentId === environmentId && s.type === "compose" && s.serverId === self.id && s.composeSubnet)
        .map((s) => s.composeSubnet!)
        .sort();
      sources.push({ ip: a.ip, networks: [envNetworkName(environmentId)], subnets });
      continue;
    }
    const [, id, compose] = a.key.split(":");
    const s = byId.get(id);
    if (!s) continue;
    const allow = live
      .filter((x) => near.has(x.serverId) && x.key === environmentKey(s.environmentId))
      .map((x) => x.ip)
      .sort();
    exposures.push({
      ip: a.ip,
      service: s.id,
      compose: compose ?? null,
      deployment: s.type === "app" ? s.currentDeploymentId : null,
      network: envNetworkName(s.environmentId),
      allow,
    });
  }

  // Environments this server takes part in: it routes to the services of those only.
  const mine = new Set(live.filter((x) => x.serverId === self.id && x.key.startsWith("env:")).map((x) => x.key.slice(4)));
  const routed = (serverId: string) =>
    live
      .filter((x) => x.serverId === serverId && x.key.startsWith("svc:") && mine.has(byId.get(x.key.split(":")[1])?.environmentId ?? ""))
      .map((x) => `${x.ip}/32`)
      .sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));

  const config: Omit<AgentConfig, "hash"> = {
    privateKey: self.privateKey,
    listenPort: self.port,
    address: meshServerAddress(self.index),
    mtu: MESH_MTU,
    routes: MESH_ROUTES,
    peers: peers
      .sort((a, b) => a.index - b.index)
      .map((s) => ({
        serverId: s.id,
        publicKey: s.publicKey,
        endpoint: s.endpoint ? meshEndpoint(s.endpoint, s.port) : null,
        allowedIps: [meshServerRange(s.index), ...routed(s.id)],
      })),
    localAddresses: [...exposures.map((e) => e.ip), ...sources.map((s) => s.ip)].sort(),
    exposures,
    sources,
    imports: imports(self.id, near, services, live),
  };
  return { ...config, hash: createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 16) };
}

/** Name of the link container for a service address (one address belongs to one environment). */
export const linkName = (ip: string) => `serve-link-${ip.replaceAll(".", "-")}`;

/**
 * Services of this server's environments that run on other servers of the network: each gets a
 * link container on the environment network, answering to the same names as the service itself.
 */
function imports(serverId: string, near: Set<string>, services: PlanService[], live: PlanAddress[]): AgentConfig["imports"] {
  const envs = new Set(live.filter((a) => a.serverId === serverId && a.key.startsWith("env:")).map((a) => a.key.slice(4)));
  const out: AgentConfig["imports"] = [];
  for (const s of services) {
    // Reached directly on the environment network when it also runs here.
    // Services on servers that share no private network with this one stay out of reach.
    if (!envs.has(s.environmentId) || placements(s).includes(serverId) || !near.has(s.serverId)) continue;
    for (const { key, compose } of serviceKeys(s)) {
      const ip = live.find((a) => a.serverId === s.serverId && a.key === key)?.ip;
      if (ip) out.push({ name: linkName(ip), ip, network: envNetworkName(s.environmentId), aliases: meshAliases(s, compose) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Names a service answers to on the private network, per compose service for stacks. */
export const meshAliases = (s: PlanService, compose: string | null) => (compose ? [composeAlias(s.slug, compose)] : networkAliases(s));
