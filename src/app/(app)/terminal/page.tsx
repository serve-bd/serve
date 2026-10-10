import { requireOrg } from "@/server/auth";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { Console } from "../projects/[projectId]/services/[serviceId]/console/console";
import { consoleHints } from "../projects/[projectId]/services/[serviceId]/console/hints";
import { HostTerminal } from "../servers/[serverId]/terminal/host-terminal";
import { pickTargets } from "./pick-targets";
import { TerminalPicker, TerminalSwitcher } from "./terminal-picker";

export const metadata = { title: "Terminal" };

/** One place to open a shell: on a server (its managers) or in a service (members with console access). */
export default async function TerminalPage(props: PageProps<"/terminal">) {
  const ctx = await requireOrg();
  const { server: serverParam, service: serviceParam } = await props.searchParams;

  const { servers, services } = await pickTargets(ctx);

  const server = typeof serverParam === "string" ? servers.find((s) => s.id === serverParam) : undefined;
  const service = typeof serviceParam === "string" ? services.find((s) => s.id === serviceParam) : undefined;

  if (server || service) {
    return (
      <>
        <PageHeader
          breadcrumbs={
            service
              ? [
                  { label: "Terminal", href: "/terminal" },
                  { label: service.projectName, href: `/projects/${service.projectId}` },
                  { label: service.environmentName },
                  { label: <TerminalSwitcher current={service.id} servers={servers} services={services} /> },
                ]
              : [{ label: "Terminal", href: "/terminal" }, { label: <TerminalSwitcher current={server!.id} servers={servers} services={services} /> }]
          }
        />
        <PageBody>
          {service ? (
            <Console key={service.id} serviceId={service.id} ownServer={service.serverName || "This server"} suggestions={consoleHints(service.engine)} />
          ) : (
            <HostTerminal key={server!.id} serverId={server!.id} hostname={server!.name} user={server!.isLocal ? "root" : server!.username} />
          )}
        </PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Terminal" description="Open a shell on a server or inside a service." />
      <PageBody>
        <TerminalPicker servers={servers} services={services} canConsole={ctx.can("console.access")} />
      </PageBody>
    </>
  );
}
