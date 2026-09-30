import { instanceAdminPage } from "@/server/auth";
import { headers } from "next/headers";
import { getSettings } from "@/server/settings";
import { securityChecks } from "@/server/security-checks";
import { dashboardVisitorIp } from "@/server/proxy/trusted-proxies";
import { SecurityView } from "./security-view";

export const metadata = { title: "Security" };

export default async function SecurityPage() {
  await instanceAdminPage();
  const [settings, h] = await Promise.all([getSettings(), headers()]);
  const checks = await securityChecks(settings);
  const raw = ((await dashboardVisitorIp(h)) ?? "").replace(/^::ffff:/, "");
  // Loopback means the page was opened on the dashboard port, where the allowlist does not apply.
  const viewerIp = raw && !/^(::1|127\.|localhost)/.test(raw) ? raw : null;
  return <SecurityView checks={checks} allowlist={settings.dashboardAllowlist} dashboardDomain={settings.dashboardDomain} viewerIp={viewerIp} />;
}
