import { getSettings } from "@/server/settings";
import { ServerMetrics } from "./server-metrics";

export const metadata = { title: "Metrics" };

export default async function MetricsPage() {
  const settings = await getSettings();
  return <ServerMetrics retentionHours={settings.metricsRetentionHours} />;
}
