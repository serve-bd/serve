import { eq, inArray } from "drizzle-orm";
import { serversForOrg } from "@/server/servers/access";
import { requireOrg } from "@/server/auth";
import { NoAccess } from "@/components/no-access";
import { db, schema } from "@/server/db";
import { Cloudflare, type CfZone } from "@/server/cloudflare/api";
import { getSettings } from "@/server/settings";
import { oauthConfig } from "@/server/cloudflare/oauth";
import { CloudflareAccounts } from "./accounts";

export const metadata = { title: "Cloudflare" };

export default async function CloudflarePage() {
  const ctx = await requireOrg();
  if (!ctx.can("integrations.manage")) return <NoAccess permission="integrations.manage" />;
  const accounts = await db.select().from(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.organizationId, ctx.org.id));
  const withZones = await Promise.all(
    accounts.map(async (a) => {
      try {
        const zones: CfZone[] = await (await Cloudflare.forRow(a)).zones();
        return {
          id: a.id,
          name: a.name,
          cfAccountId: a.cfAccountId,
          oauth: a.authType === "oauth",
          zones: zones.map((z) => ({ id: z.id, name: z.name, status: z.status, plan: z.plan?.name ?? null })),
          error: null as string | null,
        };
      } catch (e) {
        return { id: a.id, name: a.name, cfAccountId: a.cfAccountId, oauth: a.authType === "oauth", zones: [], error: (e as Error).message };
      }
    }),
  );
  const [servers, tunnelRows, settings] = await Promise.all([
    serversForOrg(ctx.org.id),
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
      .where(eq(schema.cloudflareTunnel.organizationId, ctx.org.id)),
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
  return (
    <CloudflareAccounts
      servers={servers.map((s) => ({ id: s.id, name: s.name, isLocal: s.isLocal, status: s.status }))}
      tunnels={tunnels}
      title="Cloudflare"
      description={<>Manage DNS records, SSL modes and certificates for your Cloudflare zones without leaving the dashboard.</>}
      accounts={withZones}
      isAdmin={ctx.can("integrations.manage")}
      oauth={!!oauthConfig()}
    />
  );
}
