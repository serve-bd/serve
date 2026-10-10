import { and, eq, inArray, isNull } from "drizzle-orm";
import { serversForOrg } from "@/server/servers/access";
import { db, schema } from "@/server/db";
import { Cloudflare } from "@/server/cloudflare/api";
import { getSettings } from "@/server/settings";
import type { AccountSummary } from "./accounts";

type Row = typeof schema.cloudflareAccount.$inferSelect;

/** Everything an account's page shows: its domains, the servers and its tunnels. */
export async function accountPageData(organizationId: string, row: Row, summary: AccountSummary) {
  let zones: { id: string; name: string; status: string; plan: string | null }[] = [];
  let error: string | null = null;
  try {
    zones = (await (await Cloudflare.forRow(row)).zones()).map((z) => ({ id: z.id, name: z.name, status: z.status, plan: z.plan?.name ?? null }));
  } catch (e) {
    error = (e as Error).message;
  }

  const [servers, tunnelRows, settings] = await Promise.all([
    serversForOrg(organizationId),
    db
      .select({
        id: schema.cloudflareTunnel.id,
        accountId: schema.cloudflareTunnel.cloudflareAccountId,
        serverId: schema.cloudflareTunnel.serverId,
        name: schema.cloudflareTunnel.name,
        cfTunnelId: schema.cloudflareTunnel.cfTunnelId,
        status: schema.cloudflareTunnel.status,
        statusMessage: schema.cloudflareTunnel.statusMessage,
        createdAt: schema.cloudflareTunnel.createdAt,
        updatedAt: schema.cloudflareTunnel.updatedAt,
      })
      .from(schema.cloudflareTunnel)
      // One per server: apps' shared tunnels (Closest server) show in their app's settings.
      .where(and(eq(schema.cloudflareTunnel.organizationId, organizationId), eq(schema.cloudflareTunnel.cloudflareAccountId, row.id), isNull(schema.cloudflareTunnel.serviceId))),
    getSettings(),
  ]);
  // Domains routed through each tunnel, with the service they belong to.
  const routed = tunnelRows.length
    ? await db
        .select({
          tunnelId: schema.domain.tunnelId,
          hostname: schema.domain.hostname,
          serviceId: schema.service.id,
          serviceName: schema.service.name,
          projectId: schema.service.projectId,
        })
        .from(schema.domain)
        .innerJoin(schema.service, eq(schema.domain.serviceId, schema.service.id))
        .where(
          inArray(
            schema.domain.tunnelId,
            tunnelRows.map((t) => t.id),
          ),
        )
    : [];
  const tunnels = tunnelRows.map((t) => ({
    ...t,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    domains: [
      ...(settings.dashboardTunnelId === t.id && settings.dashboardDomain ? [{ hostname: settings.dashboardDomain, service: null }] : []),
      ...routed
        .filter((d) => d.tunnelId === t.id)
        .sort((a, b) => a.hostname.localeCompare(b.hostname))
        .map((d) => ({ hostname: d.hostname, service: { name: d.serviceName, href: `/projects/${d.projectId}/services/${d.serviceId}/domains` } })),
    ],
  }));
  return {
    account: { ...summary, error },
    zones,
    servers: servers.map((s) => ({ id: s.id, name: s.name, isLocal: s.isLocal, status: s.status })),
    tunnels,
  };
}
