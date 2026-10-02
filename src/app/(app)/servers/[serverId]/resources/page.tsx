import { requireOrg } from "@/server/auth";
import { hostSummary, listHostContainers } from "@/server/servers/resources";
import { Card, EmptyState } from "@/components/ui/misc";
import { ResourcesView } from "./resources-view";
import { loadServer, withTimeout } from "../_lib/load";

export const metadata = { title: "Resources" };

export default async function ResourcesPage(props: PageProps<"/servers/[serverId]/resources">) {
  const { serverId } = await props.params;
  const { server } = await loadServer(serverId);
  const ctx = await requireOrg();
  const data = await withTimeout(
    server().then((ctx) => Promise.all([listHostContainers(ctx), hostSummary(ctx)])),
    12_000,
  );
  if (!data) {
    return (
      <Card>
        <EmptyState title="Docker is not reachable" description="Validate the server connection on the General page, then come back." />
      </Card>
    );
  }
  return <ResourcesView serverId={serverId} containers={data[0]} summary={data[1]} canMove={ctx.isInstanceAdmin && ctx.isRoot} />;
}
