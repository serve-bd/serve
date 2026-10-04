import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { normalizeDistribution } from "@/server/deploy/distribution";
import { replicaCount } from "@/lib/refs";
import { meshMemberIds, privatelyConnected } from "@/server/mesh/members";
import { copyKey, linkName } from "@/server/mesh/plan";
import { balancedTargets, type Copy } from "./balance-rules";

export * from "./balance-rules";

/*
 * Load balancing across servers: the proxy of an app's own server sends traffic to its local
 * containers and to the app's copies on its extra servers. Each copy has an address in the private
 * network (mesh/plan copyKey); the own server reaches it through a link container named after that
 * address, so the proxy targets "<link>:<port>" and the copy's server spreads it over its replicas.
 */

type ServiceRow = Pick<typeof schema.service.$inferSelect, "id" | "type" | "serverId" | "distribution" | "currentDeploymentId" | "runtime" | "balance">;

/** The app's copies on its extra servers and whether each can take traffic. Empty for other services. */
export async function appCopies(service: ServiceRow): Promise<Copy[]> {
  if (service.type !== "app") return [];
  const extras = normalizeDistribution(service.serverId, service.distribution).extraServerIds;
  if (!extras.length) return [];
  const keys = extras.map((x) => copyKey(service.id, x));
  const [addresses, members, deployment] = await Promise.all([
    db
      .select({ serverId: schema.meshAddress.serverId, key: schema.meshAddress.key, ip: schema.meshAddress.ip })
      .from(schema.meshAddress)
      .where(inArray(schema.meshAddress.key, keys)),
    meshMemberIds(),
    service.currentDeploymentId
      ? db
          .select({ targets: schema.deployment.targets })
          .from(schema.deployment)
          .where(and(eq(schema.deployment.id, service.currentDeploymentId), eq(schema.deployment.serviceId, service.id)))
          .then((r) => r[0] ?? null)
      : null,
  ]);
  const weight = replicaCount(service.runtime.replicas);
  return extras.map((serverId) => {
    const address = addresses.find((a) => a.serverId === serverId && a.key === copyKey(service.id, serverId));
    const target = deployment?.targets?.find((t) => t.serverId === serverId);
    const health = service.balance?.copies?.[serverId];
    return {
      serverId,
      host: address ? linkName(address.ip) : null,
      weight,
      deployed: !!target && (target.status === "success" || target.status === "pending" || target.status === "deploying"),
      linked: privatelyConnected(members, service.serverId, serverId),
      healthy: health ? health.ok : null,
      error: health?.error ?? null,
      since: health?.since ?? null,
    };
  });
}

/** Remote targets ("host:port" with a weight) for one port of an app, on the server whose proxy is rendered. */
export async function remoteTargets(service: ServiceRow, renderedOn: string, local: number, port: number) {
  if (renderedOn !== service.serverId) return [];
  return balancedTargets(local, await appCopies(service)).map((t) => ({ server: `${t.host}:${port}`, weight: t.weight }));
}
