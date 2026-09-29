import { hostInfo } from "@/server/system";
import { HostTerminal } from "./host-terminal";
import { loadServer, withTimeout } from "../_lib/load";

export const metadata = { title: "Terminal" };

export default async function ServerTerminalPage(props: PageProps<"/servers/[serverId]/terminal">) {
  const { serverId } = await props.params;
  const { row, server } = await loadServer(serverId);
  const host = await withTimeout(server().then((ctx) => hostInfo(ctx)));
  return <HostTerminal serverId={serverId} hostname={host?.name ?? row.name} user={row.isLocal ? "root" : row.username} local={row.isLocal} />;
}
