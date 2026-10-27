import { PageBody } from "@/components/shell/page-header";
import { requireOrg } from "@/server/auth";
import { pageService } from "@/server/services/access";

/**
 * A database's backups, importing one and the schedule are pages of their own: they open under
 * Backups in the service's menu. Other services' backups page brings its own frame.
 */
export default async function BackupsLayout(props: LayoutProps<"/projects/[projectId]/services/[serviceId]/backups">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  if (!service.database || !ctx.can("databases.backups")) return props.children;
  return <PageBody>{props.children}</PageBody>;
}
