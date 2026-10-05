/**
 * The main server of an app: the one visitors enter through. Its proxy holds the domains and the
 * certificates and, with load balancing, spreads visitors over the other servers. An app on several
 * servers can make another of them the main one without a redeploy (see setMainServer).
 *
 * This file only decides; it changes nothing. The domains page and the settings page show what it
 * says, and setMainServer follows it.
 */

export type EntryTunnel = { id: string; accountId: string; accountName?: string; status?: string };

export type EntryServer = {
  id: string;
  name: string;
  /** The app's main server now. */
  main: boolean;
  /** Validated and reachable (the local server always is). */
  reachable: boolean;
  proxyKind: string;
  proxyStopped: boolean;
  publicIp: string | null;
  /** This organization's Cloudflare Tunnels on the server. */
  tunnels: EntryTunnel[];
  /** It runs the app's current deployment (the main server always does once deployed). */
  deployed: boolean;
  /** Host ports of its proxy, and how Traefik validates certificates there (for the domain dialog). */
  proxyPorts?: { http: number; https: number };
  acmeChallenge?: "http" | "tls" | "dns-cloudflare";
};

export type EntryDomain = {
  id: string;
  hostname: string;
  generated: boolean;
  /** Served over HTTPS by Serve's proxy (its certificate is copied to a new main server). */
  https?: boolean;
  tunnelId: string | null;
  /** Meant for a tunnel; with no tunnelId it waits for one on the main server. */
  wantsTunnel?: boolean;
  /** Account of the tunnel the domain goes through, when it does. */
  tunnelAccountId: string | null;
  cloudflareAccountId: string | null;
  cloudflareZoneId: string | null;
  /** Serve made the DNS record (an A record, or the CNAME of a tunnel). */
  managedRecord: boolean;
};

/** Why visitors cannot enter through this server, or null when they can. */
export function entryProblem(s: EntryServer): string | null {
  if (!s.reachable) return `${s.name} is not reachable. Check it in Servers.`;
  if (s.proxyKind === "none") return `No proxy runs on ${s.name}, so it cannot take visitors. Turn on a proxy in the server's Proxy settings.`;
  if (s.proxyStopped) return `The proxy on ${s.name} is stopped, so it cannot take visitors. Start it in the server's Proxy settings.`;
  if (!s.publicIp && !s.tunnels.length) return `${s.name} has no public IP and no Cloudflare Tunnel, so visitors cannot reach it. Set its public IP, or add a tunnel to it.`;
  if (!s.deployed) return `${s.name} does not run the current version of this app yet. Deploy it first.`;
  return null;
}

export type DomainMove =
  /** Nothing to change: the name does not lead to a server (a redirect still needs one, and has it). */
  | { domainId: string; hostname: string; kind: "keep" }
  /**
   * The A record in a connected Cloudflare zone now points at the new server's IP: Serve's own
   * record, or the user's own one when it pointed at the old main server (anything else is left alone).
   */
  | { domainId: string; hostname: string; kind: "record"; ip: string }
  /** The user's own DNS: they point it at this IP. */
  | { domainId: string; hostname: string; kind: "manual"; ip: string }
  /** Through the new server's tunnel of the same Cloudflare account. */
  | { domainId: string; hostname: string; kind: "tunnel"; tunnelId: string }
  /** It went through a tunnel; the new server has none for it, so an A record to its IP instead. */
  | { domainId: string; hostname: string; kind: "untunnel"; ip: string }
  /** A generated name (sslip.io, wildcard) of the old server: renamed for the new one. */
  | { domainId: string; hostname: string; kind: "rename" };

export type EntryPlan = { moves: DomainMove[]; blockers: string[] };

/**
 * How each domain reaches the new main server. A blocker means a domain would stop working, and
 * the switch is refused: the user fixes it first (adds a tunnel or a public IP, or removes the domain).
 */
export function entryPlan(target: Pick<EntryServer, "name" | "publicIp" | "tunnels">, domains: EntryDomain[]): EntryPlan {
  const moves: DomainMove[] = [];
  const blockers: string[] = [];
  const tunnelFor = (accountId: string | null) => (accountId ? target.tunnels.find((t) => t.accountId === accountId) : undefined);
  for (const d of domains) {
    const base = { domainId: d.id, hostname: d.hostname };
    if (d.generated) {
      moves.push({ ...base, kind: "rename" });
      continue;
    }
    if (d.tunnelId) {
      const same = tunnelFor(d.tunnelAccountId);
      if (same) moves.push({ ...base, kind: "tunnel", tunnelId: same.id });
      else if (target.publicIp && d.cloudflareZoneId) moves.push({ ...base, kind: "untunnel", ip: target.publicIp });
      else
        blockers.push(`${d.hostname} goes through a Cloudflare Tunnel, and ${target.name} has no tunnel of that Cloudflare account${target.publicIp ? "" : " and no public IP"}.`);
      continue;
    }
    // Waiting for a tunnel: the new server's tunnel of its account takes it, else it keeps waiting.
    if (d.wantsTunnel) {
      const tunnel = tunnelFor(d.cloudflareAccountId);
      moves.push(tunnel && d.cloudflareZoneId ? { ...base, kind: "tunnel", tunnelId: tunnel.id } : { ...base, kind: "keep" });
      continue;
    }
    if (target.publicIp) {
      moves.push({ ...base, kind: d.cloudflareZoneId && (d.managedRecord || d.cloudflareAccountId) ? "record" : "manual", ip: target.publicIp });
      continue;
    }
    // No public IP: only a tunnel of the account that holds the domain's zone can carry it.
    const tunnel = d.cloudflareZoneId && !d.hostname.startsWith("*.") ? tunnelFor(d.cloudflareAccountId) : undefined;
    if (tunnel) moves.push({ ...base, kind: "tunnel", tunnelId: tunnel.id });
    else
      blockers.push(
        d.hostname.startsWith("*.")
          ? `${d.hostname} is a wildcard, which cannot go through a tunnel, and ${target.name} has no public IP.`
          : `${d.hostname} needs a public IP or a Cloudflare Tunnel of its zone's account on ${target.name}.`,
      );
  }
  return { moves, blockers };
}

/**
 * Extra servers in their new order: the old main one takes the place of the new one. Replica
 * numbers follow this order, so the same numbers stay in use and no two replicas share one.
 */
export function swappedExtras(oldMain: string, newMain: string, extras: string[]) {
  const i = extras.indexOf(newMain);
  if (i < 0) return extras;
  const next = [...extras];
  next[i] = oldMain;
  return [...new Set(next.filter((id) => id !== newMain))];
}
