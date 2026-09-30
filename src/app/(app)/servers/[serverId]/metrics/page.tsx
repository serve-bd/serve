import { ServerMetrics } from "./server-metrics";
import { loadServerView } from "../_lib/load";

export const metadata = { title: "Metrics" };

export default async function MetricsPage(props: PageProps<"/servers/[serverId]/metrics">) {
  const { serverId } = await props.params;
  const { row } = await loadServerView(serverId);
  return <ServerMetrics serverId={serverId} retentionHours={row.metricsRetentionHours} />;
}
