import type { DistributionConfig } from "@/server/services/types";

/**
 * Build once, run on many servers. A service keeps its own server (the primary:
 * it owns the domains' certificates, tunnels, logs and metrics). Optionally it
 * builds on another server and runs on extra servers; a registry carries the
 * image between them.
 */
export type Distribution = {
  buildServerId: string | null;
  registryId: string | null;
  repository: string | null;
  tag: string | null;
  tagLatest: boolean;
  extraServerIds: string[];
};

/** Canonical form: the primary never appears as build or extra server, no duplicates. */
export function normalizeDistribution(primaryId: string, dist: DistributionConfig | null | undefined): Distribution {
  const buildServerId = dist?.buildServerId && dist.buildServerId !== primaryId ? dist.buildServerId : null;
  const extraServerIds = [...new Set((dist?.extraServerIds ?? []).filter((id) => id && id !== primaryId))];
  return {
    buildServerId,
    registryId: dist?.registryId || null,
    repository: dist?.repository?.trim() || null,
    tag: dist?.tag?.trim() || null,
    tagLatest: !!dist?.tagLatest,
    extraServerIds,
  };
}

/** True when a git build must travel through a registry: built elsewhere or run on more than one server. */
export function needsRegistry(dist: Distribution, sourceType: "git" | "image" | null | undefined) {
  if (sourceType !== "git") return false;
  return !!dist.buildServerId || dist.extraServerIds.length > 0;
}

/** Why a distribution cannot deploy, or null. Checked when saving and again before each deployment. */
export function distributionProblem(dist: Distribution, sourceType: "git" | "image" | null | undefined): string | null {
  if (needsRegistry(dist, sourceType) && !dist.registryId) {
    return dist.buildServerId
      ? "Choose a registry: the image is built on another server, so the service's server has to pull it from a registry."
      : "Choose a registry: extra servers pull the built image from it.";
  }
  if (dist.registryId && sourceType === "git" && !dist.repository) return "Enter the repository to push to, like team/app.";
  if (dist.extraServerIds.length > 10) return "A service can run on up to 10 extra servers.";
  return null;
}

/** Every server a service runs on, primary first. */
export function runServerIds(primaryId: string, dist: DistributionConfig | null | undefined) {
  return [primaryId, ...normalizeDistribution(primaryId, dist).extraServerIds];
}

/** Anything beyond the classic single-server setup. */
export function isDistributed(primaryId: string, dist: DistributionConfig | null | undefined) {
  const d = normalizeDistribution(primaryId, dist);
  return !!(d.buildServerId || d.registryId || d.extraServerIds.length);
}
