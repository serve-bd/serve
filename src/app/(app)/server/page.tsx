import { getSettings } from "@/server/settings";
import { hostInfo, serverHealth } from "@/server/system";
import { proxyStatus } from "@/server/proxy/nginx";
import { commandExists } from "@/server/process";
import { env } from "@/server/env";
import { GeneralSettings, ServerOverview } from "./general";

export const metadata = { title: "Server" };

export default async function ServerGeneralPage() {
  const settings = await getSettings();
  const [host, health, proxy, nixpacks] = await Promise.all([hostInfo(), serverHealth(settings), proxyStatus().catch(() => null), commandExists("nixpacks")]);
  return (
    <>
      <ServerOverview
        host={host}
        health={{ ...health, proxyStartedAt: proxy?.startedAt ?? null }}
        extra={{ nixpacks, dataDir: env.dataDir, proxyPorts: `${env.proxyHttpPort} / ${env.proxyHttpsPort}` }}
      />
      <GeneralSettings initial={{ instanceName: settings.instanceName, serverIp: settings.serverIp ?? "", timezone: settings.timezone }} />
    </>
  );
}
