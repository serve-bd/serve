import { instanceAdminPage } from "@/server/auth";
import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LOCAL_SERVER_ID } from "@/server/db/schema";
import { getSettings } from "@/server/settings";
import { DashboardSettings } from "./dashboard-settings";

export const metadata = { title: "Dashboard & TLS" };

export default async function DashboardSettingsPage() {
  await instanceAdminPage();
  const [s, [local], tunnels] = await Promise.all([
    getSettings(),
    db.select({ publicIp: schema.server.publicIp }).from(schema.server).where(eq(schema.server.id, LOCAL_SERVER_ID)),
    db
      .select({ id: schema.cloudflareTunnel.id, account: schema.cloudflareAccount.name, status: schema.cloudflareTunnel.status })
      .from(schema.cloudflareTunnel)
      .innerJoin(schema.cloudflareAccount, eq(schema.cloudflareTunnel.cloudflareAccountId, schema.cloudflareAccount.id))
      .where(eq(schema.cloudflareTunnel.serverId, LOCAL_SERVER_ID)),
  ]);
  // A tunnel id whose tunnel is gone means "waiting for a tunnel", not a usable choice.
  const tunnelId = s.dashboardTunnelId && tunnels.some((t) => t.id === s.dashboardTunnelId) ? s.dashboardTunnelId : null;
  return (
    <DashboardSettings
      serverIp={local?.publicIp ?? s.serverIp}
      dashboard={{
        dashboardDomain: s.dashboardDomain ?? "",
        dashboardHttps: s.dashboardHttps,
        dashboardTunnelId: tunnelId,
        dashboardWantsTunnel: !!s.dashboardDomain && (s.dashboardWantsTunnel || !!s.dashboardTunnelId),
      }}
      tunnels={tunnels.map((t) => ({ id: t.id, label: `${t.account} · ${t.status === "healthy" ? "connected" : t.status}` }))}
      acme={{ acmeEmail: s.acmeEmail ?? "", acmeStaging: s.acmeStaging }}
    />
  );
}
