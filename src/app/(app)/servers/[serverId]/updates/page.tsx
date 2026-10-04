import { UpdatesView } from "./updates-view";
import { loadServer } from "../_lib/load";

export const metadata = { title: "OS updates" };

export default async function UpdatesPage(props: PageProps<"/servers/[serverId]/updates">) {
  const { serverId } = await props.params;
  const { row } = await loadServer(serverId);
  return <UpdatesView serverId={serverId} local={row.isLocal} state={row.osUpdates ?? null} sshUser={row.isLocal ? null : row.username} />;
}
