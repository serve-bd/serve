import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LOCAL_SERVER_ID } from "@/server/db/schema";
import { getSettings } from "@/server/settings";
import { DashboardSettings } from "./dashboard-settings";

export const metadata = { title: "Dashboard & TLS" };

export default async function DashboardSettingsPage() {
  const [s, [local], tunnels] = await Promise.all([
    getSettings(),
    db.select({ publicIp: schema.server.publicIp }).from(schema.server).where(eq(schema.server.id, LOCAL_SERVER_ID)),
    db
      .select({ id: schema.cloudflareTunnel.id, account: schema.cloudflareAccount.name, status: schema.cloudflareTunnel.status })
      .from(schema.cloudflareTunnel)
      .innerJoin(schema.cloudflareAccount, eq(schema.cloudflareTunnel.cloudflareAccountId, schema.cloudflareAccount.id))
      .where(eq(schema.cloudflareTunnel.serverId, LOCAL_SERVER_ID)),
  ]);
  return (
    <DashboardSettings
      serverIp={local?.publicIp ?? s.serverIp}
      dashboard={{ dashboardDomain: s.dashboardDomain ?? "", dashboardHttps: s.dashboardHttps, dashboardTunnelId: s.dashboardTunnelId }}
      tunnels={tunnels.map((t) => ({ id: t.id, label: `${t.account} · ${t.status === "healthy" ? "connected" : t.status}` }))}
      acme={{ acmeEmail: s.acmeEmail ?? "", acmeStaging: s.acmeStaging }}
    />
  );
}
