import { eq, sql } from "drizzle-orm";
import { serversForOrg } from "@/server/servers/access";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { decrypt } from "@/server/crypto";
import { Cloudflare, type CfZone } from "@/server/cloudflare/api";
import { CloudflareAccounts } from "./accounts";

export const metadata = { title: "Cloudflare" };

export default async function CloudflarePage() {
  const ctx = await requireOrg();
  const accounts = await db.select().from(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.organizationId, ctx.org.id));
  const withZones = await Promise.all(
    accounts.map(async (a) => {
      try {
        const zones: CfZone[] = await new Cloudflare(decrypt(a.apiToken)).zones();
        return { id: a.id, name: a.name, zones: zones.map((z) => ({ id: z.id, name: z.name, status: z.status, plan: z.plan?.name ?? null })), error: null as string | null };
      } catch (e) {
        return { id: a.id, name: a.name, zones: [], error: (e as Error).message };
      }
    }),
  );
  const [servers, tunnels] = await Promise.all([
    serversForOrg(ctx.org.id),
    db
      .select({
        id: schema.cloudflareTunnel.id,
        accountId: schema.cloudflareTunnel.cloudflareAccountId,
        serverId: schema.cloudflareTunnel.serverId,
        status: schema.cloudflareTunnel.status,
        statusMessage: schema.cloudflareTunnel.statusMessage,
        domains: sql<number>`(select count(*)::int from domain d where d.tunnel_id = ${schema.cloudflareTunnel.id})`,
      })
      .from(schema.cloudflareTunnel)
      .where(eq(schema.cloudflareTunnel.organizationId, ctx.org.id)),
  ]);
  return (
    <CloudflareAccounts
      servers={servers.map((s) => ({ id: s.id, name: s.name, isLocal: s.isLocal, status: s.status }))}
      tunnels={tunnels}
      title="Cloudflare"
      description="Manage DNS records, SSL modes and certificates for your Cloudflare zones without leaving Serve."
      accounts={withZones}
      isAdmin={ctx.isAdmin}
    />
  );
}
