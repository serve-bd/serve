import { ServerMetrics } from "./server-metrics";
import { loadServer } from "../_lib/load";

export const metadata = { title: "Metrics" };

export default async function MetricsPage(props: PageProps<"/servers/[serverId]/metrics">) {
  const { serverId } = await props.params;
  const { row } = await loadServer(serverId);
  return <ServerMetrics serverId={serverId} retentionHours={row.metricsRetentionHours} />;
}
