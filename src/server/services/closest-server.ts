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

/** How a domain was reached before Closest server took it over, to go back to on turning it off. */
export type DomainBefore = {
  /** A server tunnel, an A record to the main server's IP, or no DNS record at all. */
  record: "tunnel" | "a" | "none";
  tunnelId: string | null;
  /** The A record's Cloudflare proxy (orange cloud). */
  proxied: boolean;
  https: boolean;
  forceHttps: boolean;
  certificateId: string | null;
  wantsTunnel: boolean;
};

/** The setup before Closest server, kept on its shared tunnel. */
export type ClosestRestore = { loadBalance: boolean | null; domains: Record<string, DomainBefore> };

export type RestoreMove =
  | { id: string; hostname: string; kind: "tunnel"; tunnelId: string; before: DomainBefore }
  | { id: string; hostname: string; kind: "a"; ip: string; before: DomainBefore }
  | { id: string; hostname: string; kind: "none"; before: DomainBefore };

/**
 * How each domain goes back to its setup from before Closest server: its tunnel (when the main
 * server still has it), its A record (to the main server's IP now) or no record. `fallback`:
 * domains with nothing to go back to (added later, or their tunnel is gone): routed the usual way.
 */
export function restorePlan(
  domains: { id: string; hostname: string }[],
  before: ClosestRestore | null,
  main: { name: string; publicIp: string | null; tunnelIds: string[] },
): { moves: RestoreMove[]; fallback: string[]; blockers: string[] } {
  const out: ReturnType<typeof restorePlan> = { moves: [], fallback: [], blockers: [] };
  for (const d of domains) {
    const b = before?.domains[d.id];
    if (!b) {
      out.fallback.push(d.id);
      continue;
    }
    const base = { id: d.id, hostname: d.hostname, before: b };
    if (b.record === "tunnel") {
      if (b.tunnelId && main.tunnelIds.includes(b.tunnelId)) out.moves.push({ ...base, kind: "tunnel", tunnelId: b.tunnelId });
      else out.fallback.push(d.id);
    } else if (b.record === "a") {
      if (main.publicIp) out.moves.push({ ...base, kind: "a", ip: main.publicIp });
      else out.blockers.push(`${d.hostname} had an A record, and ${main.name} has no public IP to point it at.`);
    } else out.moves.push({ ...base, kind: "none" });
  }
  return out;
}
