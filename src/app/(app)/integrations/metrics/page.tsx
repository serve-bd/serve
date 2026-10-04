import { requireOrg } from "@/server/auth";
import { publicBaseUrl } from "@/server/git/github-app";
import { getSettings } from "@/server/settings";
import { MetricsExport } from "./metrics-export";

export const metadata = { title: "Metrics" };

export default async function MetricsPage() {
  const ctx = await requireOrg();
  const [baseUrl, settings] = await Promise.all([publicBaseUrl(), getSettings()]);
  return (
    <MetricsExport
      baseUrl={baseUrl}
      apiEnabled={settings.apiEnabled}
      canReadRequests={ctx.can("logs.view")}
      // Like on the dashboard, host figures go to Root admins only, through tokens of the Root organization.
      hostMetrics={ctx.isInstanceAdmin && settings.rootOrganizationId === ctx.org.id && !ctx.projectIds}
    />
  );
}
