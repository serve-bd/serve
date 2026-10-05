import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { runServerIds } from "@/server/deploy/distribution";
import type { EntryDomain, EntryServer } from "./entry-plan";

type ServiceRow = Pick<typeof schema.service.$inferSelect, "id" | "type" | "serverId" | "distribution" | "currentDeploymentId">;

/** Every server an app runs on, main first, with what visitors need to enter through it. */
export async function entryServers(service: ServiceRow, organizationId: string): Promise<EntryServer[]> {
  const ids = service.type === "app" ? runServerIds(service.serverId, service.distribution) : [service.serverId];
  const [servers, tunnels, deployment] = await Promise.all([
    db
      .select({
        id: schema.server.id,
        name: schema.server.name,
        status: schema.server.status,
        isLocal: schema.server.isLocal,
        proxyKind: schema.server.proxyKind,
        proxyStopped: schema.server.proxyStopped,
        publicIp: schema.server.publicIp,
        httpPort: schema.server.proxyHttpPort,
        httpsPort: schema.server.proxyHttpsPort,
        proxyConfig: schema.server.proxyConfig,
      })
      .from(schema.server)
      .where(inArray(schema.server.id, ids)),
    db
      .select({
        id: schema.cloudflareTunnel.id,
        serverId: schema.cloudflareTunnel.serverId,
        accountId: schema.cloudflareTunnel.cloudflareAccountId,
        accountName: schema.cloudflareAccount.name,
        status: schema.cloudflareTunnel.status,
      })
      .from(schema.cloudflareTunnel)
      .innerJoin(schema.cloudflareAccount, eq(schema.cloudflareTunnel.cloudflareAccountId, schema.cloudflareAccount.id))
      .where(and(eq(schema.cloudflareTunnel.organizationId, organizationId), inArray(schema.cloudflareTunnel.serverId, ids))),
    service.currentDeploymentId
      ? db
          .select({ targets: schema.deployment.targets })
          .from(schema.deployment)
          .where(eq(schema.deployment.id, service.currentDeploymentId))
          .then((r) => r[0] ?? null)
      : null,
  ]);
  return ids.flatMap((id) => {
    const s = servers.find((x) => x.id === id);
    if (!s) return [];
    const main = id === service.serverId;
    const target = deployment?.targets?.find((t) => t.serverId === id);
    return [
      {
        id,
        name: s.name,
        main,
        reachable: s.isLocal || s.status === "ready",
        proxyKind: s.proxyKind,
        proxyStopped: s.proxyStopped,
        publicIp: s.publicIp,
        tunnels: tunnels.filter((t) => t.serverId === id).map(({ serverId: _, ...t }) => t),
        // Before any deploy (or one without targets) the main server is all there is.
        deployed: main || target?.status === "success",
        proxyPorts: { http: s.httpPort, https: s.httpsPort },
        acmeChallenge: s.proxyConfig?.traefik?.acmeChallenge ?? "http",
      },
    ];
  });
}

/** The service's domains as entryPlan reads them. */
export async function entryDomains(serviceId: string): Promise<EntryDomain[]> {
  const rows = await db
    .select({ domain: schema.domain, tunnelAccountId: schema.cloudflareTunnel.cloudflareAccountId })
    .from(schema.domain)
    .leftJoin(schema.cloudflareTunnel, eq(schema.domain.tunnelId, schema.cloudflareTunnel.id))
    .where(eq(schema.domain.serviceId, serviceId));
  return rows.map(({ domain: d, tunnelAccountId }) => ({
    id: d.id,
    hostname: d.hostname,
    generated: d.generated,
    https: d.https,
    tunnelId: d.tunnelId,
    wantsTunnel: d.wantsTunnel,
    tunnelAccountId,
    cloudflareAccountId: d.cloudflareAccountId,
    cloudflareZoneId: d.cloudflareZoneId,
    managedRecord: !!d.cloudflareRecordId,
  }));
}
