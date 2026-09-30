import { PRIVATE_VARS, REF, referenceName } from "@/lib/refs";
import { privatelyConnected } from "./plan";

export type ImpactService = { id: string; name: string; slug: string; serverId: string; environmentId: string; projectId: string };
export type ImpactVar = { serviceId: string; key: string; value: string };

/** A service that uses another one's private name across servers that stop sharing a network. */
export type LostLink = { consumerId: string; providerId: string; variables: string[] };

/**
 * Services that reference another service's private variables (`${{postgres.DATABASE_URL}}`)
 * where the two servers share a network now but no longer would after the change.
 */
export function lostLinks(before: Map<string, string[]>, after: Map<string, string[]>, services: ImpactService[], vars: ImpactVar[]): LostLink[] {
  const lost = (a: string, b: string) => privatelyConnected(before, a, b) && !privatelyConnected(after, a, b);
  const byEnv = new Map<string, ImpactService[]>();
  for (const s of services) byEnv.set(s.environmentId, [...(byEnv.get(s.environmentId) ?? []), s]);
  const byId = new Map(services.map((s) => [s.id, s]));
  const found = new Map<string, LostLink>();
  for (const v of vars) {
    const consumer = byId.get(v.serviceId);
    if (!consumer) continue;
    const siblings = byEnv.get(consumer.environmentId) ?? [];
    for (const [, ref] of v.value.matchAll(REF)) {
      const dot = ref.indexOf(".");
      if (dot === -1 || !PRIVATE_VARS.test(ref.slice(dot + 1))) continue;
      const name = ref.slice(0, dot).toLowerCase();
      const provider = siblings.find((s) => s.id !== consumer.id && (s.slug.toLowerCase() === name || s.name.toLowerCase() === name || referenceName(s.name) === name));
      if (!provider || !lost(consumer.serverId, provider.serverId)) continue;
      const key = `${consumer.id}|${provider.id}`;
      const link = found.get(key) ?? { consumerId: consumer.id, providerId: provider.id, variables: [] };
      if (!link.variables.includes(v.key)) link.variables.push(v.key);
      found.set(key, link);
    }
  }
  return [...found.values()];
}

/** Memberships after a change: a server out of a network, a network gone, or a server leaving. */
export function membersAfter(
  before: Map<string, string[]>,
  change: { kind: "remove"; networkId: string; serverId: string } | { kind: "delete"; networkId: string } | { kind: "leave"; serverId: string },
) {
  const after = new Map([...before].map(([id, nets]) => [id, [...nets]]));
  if (change.kind === "leave") after.delete(change.serverId);
  else if (change.kind === "remove")
    after.set(
      change.serverId,
      (after.get(change.serverId) ?? []).filter((n) => n !== change.networkId),
    );
  else
    for (const [id, nets] of after)
      after.set(
        id,
        nets.filter((n) => n !== change.networkId),
      );
  return after;
}
