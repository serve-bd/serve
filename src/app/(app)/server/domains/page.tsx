import { getSettings } from "@/server/settings";
import { DomainSettings } from "./domain-settings";

export const metadata = { title: "Domains & TLS" };

export default async function ServerDomainsPage() {
  const s = await getSettings();
  return (
    <DomainSettings
      serverIp={s.serverIp}
      domains={{ wildcardDomain: s.wildcardDomain ?? "", sslipFallback: s.sslipFallback, dashboardDomain: s.dashboardDomain ?? "", dashboardHttps: s.dashboardHttps }}
      acme={{ acmeEmail: s.acmeEmail ?? "", acmeStaging: s.acmeStaging }}
    />
  );
}
