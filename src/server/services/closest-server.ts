/**
 * Closest server: an app on several servers gets one Cloudflare Tunnel with a connector on each of
 * them. Cloudflare sends each visitor to the nearest connector, and to another one when a server
 * is down. Each server's proxy serves the app from its own replicas.
 *
 * This file only decides which domains can go through the tunnel; it changes nothing.
 */

export type ClosestDomain = { id: string; hostname: string; generated: boolean };

export type ClosestPlan = {
  /** Domains that go through the tunnel, with their zone in the chosen Cloudflare account. */
  move: { id: string; hostname: string; zoneId: string }[];
  /** Domains that keep going to the main server, and why. */
  stay: { id: string; hostname: string; reason: string }[];
};

/** Which domains can go through the app's tunnel. `zones` are the zones of the chosen account. */
export function closestServerPlan(domains: ClosestDomain[], zones: { id: string; name: string }[]): ClosestPlan {
  const plan: ClosestPlan = { move: [], stay: [] };
  for (const d of domains) {
    const base = { id: d.id, hostname: d.hostname };
    if (d.generated) {
      plan.stay.push({ ...base, reason: "a generated address of the main server" });
      continue;
    }
    if (d.hostname.startsWith("*.")) {
      plan.stay.push({ ...base, reason: "a wildcard, which cannot go through a tunnel" });
      continue;
    }
    const host = d.hostname.toLowerCase();
    // The longest zone that holds the name (a delegated subdomain zone wins over its parent).
    const zone = zones.filter((z) => host === z.name || host.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
    if (!zone) {
      plan.stay.push({ ...base, reason: "not in a zone of this Cloudflare account" });
      continue;
    }
    plan.move.push({ ...base, zoneId: zone.id });
  }
  return plan;
}
