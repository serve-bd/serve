/**
 * How the proxy spreads visitors over an app's replicas:
 * - round-robin: each replica in turn.
 * - least-busy: the replica with the fewest open connections (slow requests, uploads, streams).
 * - sticky: each visitor keeps reaching the same replica (Socket.IO, sessions kept in memory).
 * - main-first: only the main server's replicas, while one of them answers; the other servers
 *   take visitors when none does (load balancing across servers only).
 */
export const BALANCING = ["round-robin", "least-busy", "sticky", "main-first"] as const;
export type Balancing = (typeof BALANCING)[number];

/** The saved strategy, reading configs saved before it existed. */
export function balancingOf(cfg: { balancing?: Balancing; sticky?: boolean } | null | undefined): Balancing {
  return cfg?.balancing ?? (cfg?.sticky ? "sticky" : "round-robin");
}
