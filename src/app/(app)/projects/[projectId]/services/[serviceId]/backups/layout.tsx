import { PageBody } from "@/components/shell/page-header";
import { requireOrg } from "@/server/auth";
import { pageService } from "@/server/services/access";
import { SettingsSidebar } from "../settings/settings-sidebar";

/** A database's backups, importing one and the schedule are pages of their own, like settings. */
export default async function BackupsLayout(props: LayoutProps<"/projects/[projectId]/services/[serviceId]/backups">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  if (!service.database || !ctx.can("databases.backups")) return props.children;
  const nav = [{ id: "", label: "Backups" }, ...(ctx.isAdmin ? [{ id: "import", label: "Import backup" }] : []), { id: "auto", label: "Auto backup" }];
  return (
    <PageBody>
      <div className="flex flex-col gap-6 xl:flex-row xl:gap-10">
        <SettingsSidebar base={`/projects/${projectId}/services/${serviceId}/backups`} nav={nav} label="Backup pages" />
        <div className="min-w-0 flex-1">{props.children}</div>
      </div>
    </PageBody>
  );
}
