import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { balances, normalizeDistribution } from "@/server/deploy/distribution";
import { balancingOf } from "@/lib/balancing";
import { replicaCount } from "@/lib/refs";
import { meshMemberIds, privatelyConnected } from "@/server/mesh/members";
import { copyKey, linkName } from "@/server/mesh/plan";
import { balancedTargets, type Copy, copyId } from "./balance-rules";

export * from "./balance-rules";

/*
 * Load balancing across servers: the proxy of an app's own server sends traffic to its local
 * containers and to the app's copies on its extra servers. Each copy has an address in the private
 * network (mesh/plan copyKey); the own server reaches it through a link container named after that
 * address, so the proxy targets "<link>:<port>" and the copy's server spreads it over its replicas.
 */

type ServiceRow = Pick<typeof schema.service.$inferSelect, "id" | "type" | "serverId" | "distribution" | "currentDeploymentId" | "runtime" | "balance">;

/**
 * The app's replicas on its extra servers (one entry per server and replica number) and whether
 * each can take traffic. Empty for other services.
 */
export async function appCopies(service: ServiceRow): Promise<Copy[]> {
  if (service.type !== "app" || !balances(service.serverId, service.distribution)) return [];
  const extras = normalizeDistribution(service.serverId, service.distribution).extraServerIds;
  if (!extras.length) return [];
  const replicas = replicaCount(service.runtime.replicas);
  const slots = Array.from({ length: replicas }, (_, i) => i + 1);
  const keys = extras.flatMap((x) => slots.map((slot) => copyKey(service.id, x, slot)));
  const [addresses, members, deployment] = await Promise.all([
    db
      .select({ serverId: schema.meshAddress.serverId, key: schema.meshAddress.key, ip: schema.meshAddress.ip })
      .from(schema.meshAddress)
      .where(inArray(schema.meshAddress.key, keys)),
    meshMemberIds(),
    service.currentDeploymentId
      ? db
          .select({ targets: schema.deployment.targets, status: schema.deployment.status })
          .from(schema.deployment)
          .where(and(eq(schema.deployment.id, service.currentDeploymentId), eq(schema.deployment.serviceId, service.id)))
          .then((r) => r[0] ?? null)
      : null,
  ]);
  return extras.flatMap((serverId) => {
    const target = deployment?.targets?.find((t) => t.serverId === serverId);
    // Pending or deploying only counts while the deploy runs: one cut short (the worker stopped)
    // leaves those servers on an older version, which gets no traffic.
    const running = deployment?.status === "queued" || deployment?.status === "building" || deployment?.status === "deploying";
    const deployed = !!target && (target.status === "success" || (running && (target.status === "pending" || target.status === "deploying")));
    const linked = privatelyConnected(members, service.serverId, serverId);
    return slots.map((slot) => {
      const address = addresses.find((a) => a.serverId === serverId && a.key === copyKey(service.id, serverId, slot));
      const health = service.balance?.copies?.[copyId(serverId, slot)];
      return {
        serverId,
        slot,
        host: address ? linkName(address.ip) : null,
        deployed,
        linked,
        healthy: health ? health.ok : null,
        error: health?.error ?? null,
        since: health?.since ?? null,
      };
    });
  });
}

/** Remote targets ("host:port" with a weight) for one port of an app, on the server whose proxy is rendered. */
export async function remoteTargets(service: ServiceRow & Pick<typeof schema.service.$inferSelect, "proxy">, renderedOn: string, local: number, port: number) {
  if (renderedOn !== service.serverId) return [];
  // Main server first: the others stand by while one of its own replicas answers.
  if (local > 0 && balancingOf(service.proxy) === "main-first" && service.balance?.main?.ok !== false) return [];
  return balancedTargets(local, await appCopies(service)).map((host) => ({ server: `${host}:${port}`, weight: 1 }));
}

/**
 * The servers among `extraIds` that load balancing from `mainId` cannot reach: they share no
 * private network with it, so its proxy never sends them a visitor. Names included, for messages.
 */
export async function serversApart(mainId: string, extraIds: string[]) {
  if (!extraIds.length) return null;
  const members = await meshMemberIds();
  const apart = extraIds.filter((id) => !privatelyConnected(members, mainId, id));
  if (!apart.length) return null;
  const rows = await db
    .select({ id: schema.server.id, name: schema.server.name })
    .from(schema.server)
    .where(inArray(schema.server.id, [mainId, ...apart]));
  const name = (id: string) => rows.find((r) => r.id === id)?.name ?? "a server";
  const list = apart.map(name);
  return { main: name(mainId), names: list.length === 1 ? list[0] : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`, one: list.length === 1 };
}

/** Why load balancing from `mainId` cannot reach these servers (a refusal), or null when it can. */
export async function balanceProblem(mainId: string, extraIds: string[]): Promise<string | null> {
  const a = await serversApart(mainId, extraIds);
  if (!a) return null;
  const it = a.one ? "it" : "them";
  return `${a.names} ${a.one ? "is" : "are"} not in a private network with ${a.main}, so load balancing cannot send ${it} any visitors. Add ${it} and ${a.main} to the same private network in Servers → Private network first, then try again. Or turn load balancing off to run the app there without visitors.`;
}

/** The same, once the app runs there (a server left the network): what happens to visitors now. */
export async function balanceWarning(mainId: string, extraIds: string[]): Promise<string | null> {
  const a = await serversApart(mainId, extraIds);
  if (!a) return null;
  return `${a.names} ${a.one ? "is" : "are"} not in a private network with ${a.main}, so every visitor goes to the replicas on ${a.main}. Add ${a.one ? "it" : "them"} back to the same private network to share the visitors again.`;
}
