import { requireOrg } from "@/server/auth";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { FileManager } from "@/components/files/file-manager";
import { pickTargets } from "../terminal/pick-targets";
import { TerminalPicker, TerminalSwitcher } from "../terminal/terminal-picker";

export const metadata = { title: "Files" };

/** One place to open files: a server's disk (its managers) or a service's container (members with console access). */
export default async function FilesPage(props: PageProps<"/files">) {
  const ctx = await requireOrg();
  const { server: serverParam, service: serviceParam } = await props.searchParams;
  const { servers, services } = await pickTargets(ctx);
  const server = typeof serverParam === "string" ? servers.find((s) => s.id === serverParam) : undefined;
  const service = typeof serviceParam === "string" ? services.find((s) => s.id === serviceParam) : undefined;

  if (server || service) {
    const switcher = <TerminalSwitcher files current={(service ?? server)!.id} servers={servers} services={services} />;
    return (
      <>
        <PageHeader
          breadcrumbs={
            service
              ? [
                  { label: "Files", href: "/files" },
                  { label: service.projectName, href: `/projects/${service.projectId}` },
                  { label: service.environmentName },
                  { label: switcher },
                ]
              : [{ label: "Files", href: "/files" }, { label: switcher }]
          }
        />
        <PageBody>
          {service ? (
            <FileManager
              key={service.id}
              endpoint={`/api/services/${service.id}/files`}
              title={service.name}
              containers={`/api/services/${service.id}/exec`}
              ownServer={service.serverName}
            />
          ) : (
            <FileManager key={server!.id} endpoint={`/api/servers/${server!.id}/files`} title={server!.name} />
          )}
        </PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Files" description="Browse, upload, download and edit files on a server or inside a service." />
      <PageBody>
        <TerminalPicker files servers={servers} services={services} canConsole={ctx.can("console.access")} />
      </PageBody>
    </>
  );
}
