import { FileManager } from "@/components/files/file-manager";
import { loadServer } from "../_lib/load";

export const metadata = { title: "Files" };

export default async function ServerFilesPage(props: PageProps<"/servers/[serverId]/files">) {
  const { serverId } = await props.params;
  const { row } = await loadServer(serverId);
  return <FileManager endpoint={`/api/servers/${row.id}/files`} title={row.name} />;
}
