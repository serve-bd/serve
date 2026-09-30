import { PageBody } from "@/components/shell/page-header";
import { requireOrg } from "@/server/auth";
import { engines } from "@/server/databases/engines";
import { pageService } from "@/server/services/access";
import { settingsNav } from "./settings-nav";
import { SettingsSidebar } from "./settings-sidebar";

/** The section list stays while a section loads; each section is its own page. */
export default async function SettingsLayout(props: LayoutProps<"/projects/[projectId]/services/[serviceId]/settings">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  // The page shows why the user cannot see settings.
  if (!ctx.can("services.manage")) return <PageBody>{props.children}</PageBody>;
  const engine = service.database ? engines[service.database.engine] : null;
  const nav = settingsNav({
    type: service.type,
    hasSource: !!service.source,
    gitSource: service.source?.type === "git",
    hasBuild: !!service.build,
    hasCompose: !!service.compose,
    previews: service.type === "app" && service.source?.type === "git" && !service.parentServiceId,
    db: service.database && engine ? { engine: service.database.engine, initScripts: !!engine.initScripts, tls: !!engine.tlsArgs } : null,
  });
  return (
    <PageBody>
      <div className="flex flex-col gap-6 xl:flex-row xl:gap-10">
        <SettingsSidebar base={`/projects/${projectId}/services/${serviceId}/settings`} nav={nav} />
        <div className="min-w-0 flex-1">{props.children}</div>
      </div>
    </PageBody>
  );
}
