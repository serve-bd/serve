import { and, eq, inArray } from "drizzle-orm";
import { notFound } from "next/navigation";
import { serversForOrg } from "@/server/servers/access";
import { requireOrg } from "@/server/auth";
import { NoAccess } from "@/components/no-access";
import { db, schema } from "@/server/db";
import { Cloudflare } from "@/server/cloudflare/api";
import { getSettings } from "@/server/settings";
import { oauthConfig } from "@/server/cloudflare/oauth";
import { CloudflareAccount } from "../accounts";
import { accountSummaries } from "../summaries";

export async function generateMetadata({ params }: PageProps<"/integrations/cloudflare/[accountId]">) {
  const { accountId } = await params;
  const [row] = await db.select({ name: schema.cloudflareAccount.name }).from(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.id, accountId));
  return { title: row ? `${row.name} · Cloudflare` : "Cloudflare" };
}

export default async function CloudflareAccountPage({ params }: PageProps<"/integrations/cloudflare/[accountId]">) {
  const { accountId } = await params;
  const ctx = await requireOrg();
  if (!ctx.can("integrations.manage")) return <NoAccess permission="integrations.manage" />;
  const found = (await accountSummaries(ctx.org.id)).find((s) => s.row.id === accountId);
  if (!found) notFound();
  const { row, summary } = found;

  let zones: { id: string; name: string; status: string; plan: string | null }[] = [];
  let error: string | null = null;
  try {
    zones = (await (await Cloudflare.forRow(row)).zones()).map((z) => ({ id: z.id, name: z.name, status: z.status, plan: z.plan?.name ?? null }));
  } catch (e) {
    error = (e as Error).message;
  }

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
      .where(and(eq(schema.cloudflareTunnel.organizationId, ctx.org.id), eq(schema.cloudflareTunnel.cloudflareAccountId, row.id))),
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
    <CloudflareAccount
      account={{ ...summary, error }}
      zones={zones}
      servers={servers.map((s) => ({ id: s.id, name: s.name, isLocal: s.isLocal, status: s.status }))}
      tunnels={tunnels}
      isAdmin={ctx.can("integrations.manage")}
      oauth={!!oauthConfig()}
    />
  );
}
