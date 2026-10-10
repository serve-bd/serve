import { NoAccess } from "@/components/no-access";
import { requireOrg } from "@/server/auth";
import { pageService } from "@/server/services/access";
import { PageBody } from "@/components/shell/page-header";
import { getServerRow } from "@/server/servers/context";
import { Console } from "./console";
import { consoleHints } from "./hints";

export const metadata = { title: "Console" };

export default async function ConsolePage(props: PageProps<"/projects/[projectId]/services/[serviceId]/console">) {
  const { projectId, serviceId } = await props.params;
  const { container } = await props.searchParams;
  const ctx = await requireOrg();
  if (!ctx.can("console.access")) return <NoAccess permission="console.access" />;
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  return (
    <PageBody>
      <Console
        serviceId={service.id}
        initialTarget={typeof container === "string" ? container : null}
        ownServer={(await getServerRow(service.serverId).catch(() => null))?.name ?? "This server"}
        suggestions={consoleHints(service.database?.engine)}
      />
    </PageBody>
  );
}
