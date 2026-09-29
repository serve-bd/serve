import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LOCAL_SERVER_ID } from "@/server/db/schema";
import { getSettings } from "@/server/settings";
import { DashboardSettings } from "./dashboard-settings";

export const metadata = { title: "Dashboard & TLS" };

export default async function DashboardSettingsPage() {
  const [s, [local]] = await Promise.all([
    getSettings(),
    db.select({ publicIp: schema.server.publicIp }).from(schema.server).where(eq(schema.server.id, LOCAL_SERVER_ID)),
  ]);
  return (
    <DashboardSettings
      serverIp={local?.publicIp ?? s.serverIp}
      dashboard={{ dashboardDomain: s.dashboardDomain ?? "", dashboardHttps: s.dashboardHttps }}
      acme={{ acmeEmail: s.acmeEmail ?? "", acmeStaging: s.acmeStaging }}
    />
  );
}
