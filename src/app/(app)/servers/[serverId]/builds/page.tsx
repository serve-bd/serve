import { BuildsCard, DeploymentsCard } from "../server-settings";
import { loadServer } from "../_lib/load";

export const metadata = { title: "Builds & deploys" };

export default async function BuildsPage(props: PageProps<"/servers/[serverId]/builds">) {
  const { serverId } = await props.params;
  const { row } = await loadServer(serverId);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6">
      <BuildsCard serverId={row.id} limits={{ buildConcurrency: row.buildConcurrency, imageRetention: row.imageRetention }} />
      <DeploymentsCard serverId={row.id} limits={{ deployTimeoutMinutes: row.deployTimeoutMinutes, deployQueueLimit: row.deployQueueLimit }} />
    </div>
  );
}
