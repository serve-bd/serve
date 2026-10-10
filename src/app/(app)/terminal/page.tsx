import { asc, eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { canManageServer } from "@/server/servers/access";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { Console } from "../projects/[projectId]/services/[serviceId]/console/console";
import { consoleHints } from "../projects/[projectId]/services/[serviceId]/console/hints";
import { HostTerminal } from "../servers/[serverId]/terminal/host-terminal";
import { TerminalPicker, TerminalSwitcher, type PickServer, type PickService } from "./terminal-picker";

export const metadata = { title: "Terminal" };

/** One place to open a shell: on a server (its managers) or in a service (members with console access). */
export default async function TerminalPage(props: PageProps<"/terminal">) {
  const ctx = await requireOrg();
  const { server: serverParam, service: serviceParam } = await props.searchParams;

  const allServers = await db
    .select({
      id: schema.server.id,
      name: schema.server.name,
      isLocal: schema.server.isLocal,
      username: schema.server.username,
      status: schema.server.status,
      ownerOrganizationId: schema.server.ownerOrganizationId,
    })
    .from(schema.server)
    .orderBy(asc(schema.server.name));
  const servers: PickServer[] = allServers.filter((s) => canManageServer(ctx, s)).map(({ ownerOrganizationId: _, ...s }) => s);
  const serverName = new Map(allServers.map((s) => [s.id, s.name]));
  const services: PickService[] = ctx.can("console.access")
    ? (
        await db
          .select({
            id: schema.service.id,
            name: schema.service.name,
            type: schema.service.type,
            icon: schema.service.icon,
            status: schema.service.status,
            database: schema.service.database,
            serverId: schema.service.serverId,
            projectId: schema.project.id,
            projectName: schema.project.name,
            environmentName: schema.environment.name,
          })
          .from(schema.service)
          .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
          .innerJoin(schema.environment, eq(schema.service.environmentId, schema.environment.id))
          .where(eq(schema.project.organizationId, ctx.org.id))
          .orderBy(asc(schema.project.name), asc(schema.environment.name), asc(schema.service.name))
      )
        .filter((s) => ctx.canAccessProject(s.projectId))
        // The database settings hold a password: only the engine goes to the page.
        .map(({ database, serverId, ...s }) => ({ ...s, engine: database?.engine ?? null, serverName: serverName.get(serverId) ?? "" }))
    : [];

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
