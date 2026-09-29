import { getSettings } from "@/server/settings";
import { ServerMetrics } from "./server-metrics";
import { loadServer } from "../_lib/load";

export const metadata = { title: "Metrics" };

export default async function MetricsPage(props: PageProps<"/servers/[serverId]/metrics">) {
  const { serverId } = await props.params;
  await loadServer(serverId);
  const settings = await getSettings();
  return <ServerMetrics serverId={serverId} retentionHours={settings.metricsRetentionHours} />;
}
