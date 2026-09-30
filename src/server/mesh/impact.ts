import { PRIVATE_VARS, referencedService, serviceReferencesIn } from "@/lib/refs";
import { type MeshMembers, reachesPrivately } from "./plan";

export type ImpactService = {
  id: string;
  name: string;
  slug: string;
  serverId: string;
  /** Every server it runs on (its own and extra servers). */
  servers: string[];
  environmentId: string;
  projectId: string;
};
export type ImpactVar = { serviceId: string; key: string; value: string };

/** A service that uses another one's private name across servers that stop sharing a network. */
export type LostLink = { consumerId: string; providerId: string; variables: string[] };

/**
 * Services whose variables use a private variable of another service (directly, through their own
 * variables or through shared variables, like variable resolution does) that they reach now but
 * would no longer reach after the change.
 */
export function lostLinks(
  before: MeshMembers,
  after: MeshMembers,
  services: ImpactService[],
  vars: ImpactVar[],
  scope: (service: ImpactService) => (scope: string, key: string) => string | undefined,
): LostLink[] {
  const byEnv = new Map<string, ImpactService[]>();
  for (const s of services) byEnv.set(s.environmentId, [...(byEnv.get(s.environmentId) ?? []), s]);
  const byId = new Map(services.map((s) => [s.id, s]));
  const varsOf = new Map<string, ImpactVar[]>();
  for (const v of vars) varsOf.set(v.serviceId, [...(varsOf.get(v.serviceId) ?? []), v]);
  const found = new Map<string, LostLink>();
  for (const v of vars) {
    const consumer = byId.get(v.serviceId);
    if (!consumer) continue;
    const siblings = byEnv.get(consumer.environmentId) ?? [];
    const shared = scope(consumer);
    // `${{KEY}}`: the service's own variable, else the environment's shared one (like resolution).
    const own = (key: string) => varsOf.get(consumer.id)?.find((x) => x.key === key)?.value ?? shared("environment", key);
    for (const ref of serviceReferencesIn(v.value, own, shared)) {
      if (!PRIVATE_VARS.test(ref.key)) continue;
      const provider = referencedService(siblings, ref.name);
      if (!provider || provider.id === consumer.id) continue;
      if (!reachesPrivately(before, consumer.servers, provider) || reachesPrivately(after, consumer.servers, provider)) continue;
      const key = `${consumer.id}|${provider.id}`;
      const link = found.get(key) ?? { consumerId: consumer.id, providerId: provider.id, variables: [] };
      if (!link.variables.includes(v.key)) link.variables.push(v.key);
      found.set(key, link);
    }
  }
  return [...found.values()];
}

/** Memberships after a change: a server out of a network, a network gone, or a server leaving. */
export type MeshChange =
  | { kind: "remove"; networkId: string; serverId: string }
  | { kind: "delete"; networkId: string }
  | { kind: "leave"; serverId: string }
  /** The server switches to "No public address". */
  | { kind: "nat"; serverId: string };

export function membersAfter(before: MeshMembers, change: MeshChange): MeshMembers {
  const after: MeshMembers = new Map([...before].map(([id, m]) => [id, { ...m, networks: [...m.networks] }]));
  if (change.kind === "leave") after.delete(change.serverId);
  else if (change.kind === "nat") {
    const m = after.get(change.serverId);
    if (m) m.nat = true;
  } else if (change.kind === "remove") {
    const m = after.get(change.serverId);
    if (m) m.networks = m.networks.filter((n) => n !== change.networkId);
  } else for (const m of after.values()) m.networks = m.networks.filter((n) => n !== change.networkId);
  return after;
}
