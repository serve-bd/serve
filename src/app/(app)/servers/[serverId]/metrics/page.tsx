import { Card, EmptyState } from "@/components/ui/misc";
import { ServerMetrics } from "./server-metrics";
import { MetricsCard } from "../server-settings";
import { agentStatus } from "../_lib/agent-status";
import { loadServerView } from "../_lib/load";

export const metadata = { title: "Metrics" };

export default async function MetricsPage(props: PageProps<"/servers/[serverId]/metrics">) {
  const { serverId } = await props.params;
  const { row, manage } = await loadServerView(serverId);
  return (
    <div className="flex flex-col gap-6">
      {row.metricsEnabled ? (
        <ServerMetrics serverId={serverId} retentionHours={row.metricsRetentionHours} canManage={manage} />
      ) : (
        <Card>
          <EmptyState
            title="Metrics are off"
            description={manage ? "Turn them on below to see CPU, memory and disk of this server and its services." : "An admin of this server can turn them on."}
          />
        </Card>
      )}
      {manage && <MetricsCard serverId={row.id} enabled={row.metricsEnabled} hours={row.metricsRetentionHours} agent={row.isLocal ? null : agentStatus(row)} />}
    </div>
  );
}
