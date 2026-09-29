/**
 * Build slots are per server: a deploy counts against the server that builds it (the service's
 * build server when it has one, else its own server). A full server only holds back its own builds.
 */

export const DEFAULT_BUILD_CONCURRENCY = 2;

/** Servers whose running builds reached their limit. */
export function fullBuildServers(runningBuildServers: (string | null)[], limits: Map<string, number>) {
  const counts = new Map<string, number>();
  for (const id of runningBuildServers) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts].filter(([id, n]) => n >= Math.max(1, limits.get(id) ?? DEFAULT_BUILD_CONCURRENCY)).map(([id]) => id);
}

/** Oldest metric sample kept for a server's history in hours (at least one hour). */
export function metricsCutoff(retentionHours: number, now = Date.now()) {
  return new Date(now - Math.max(1, retentionHours) * 3600_000);
}

/** The server that builds a service: its build server from the distribution settings, else its own. */
export function buildServerOf(service: { serverId: string; distribution?: { buildServerId?: string | null } | null }) {
  return service.distribution?.buildServerId || service.serverId;
}
