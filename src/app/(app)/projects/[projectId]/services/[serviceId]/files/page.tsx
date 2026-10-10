import { NoAccess } from "@/components/no-access";
import { FileManager } from "@/components/files/file-manager";
import { PageBody } from "@/components/shell/page-header";
import { requireOrg } from "@/server/auth";
import { getServerRow } from "@/server/servers/context";
import { pageService } from "@/server/services/access";

export const metadata = { title: "Files" };

export default async function ServiceFilesPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/files">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  if (!ctx.can("console.access")) return <NoAccess permission="console.access" />;
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  return (
    <PageBody>
      <FileManager
        endpoint={`/api/services/${service.id}/files`}
        title={service.name}
        containers={`/api/services/${service.id}/exec`}
        ownServer={(await getServerRow(service.serverId).catch(() => null))?.name ?? "This server"}
      />
    </PageBody>
  );
}
